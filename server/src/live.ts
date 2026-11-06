// Live state store, kept up to date from AbletonOSC listeners. Cue points, scene/track counts and
// scene is_empty have no listener, so they are polled lightly.

import { EventEmitter } from 'node:events';
import type { LiveState, Scene, Track } from '@setdeck/shared';
import { OSC, type SongProp, type TrackProp } from './osc-map.ts';
import type { Arg, OscClient } from './osc-client.ts';

const bool = (v: Arg | undefined) => v === true || v === 1;

const SONG: Partial<Record<SongProp, (s: LiveState, v: Arg) => void>> = {
  current_song_time: (s, v) => { s.position = Number(v); },
  is_playing: (s, v) => { s.playing = bool(v); },
  tempo: (s, v) => { s.tempo = Number(v); },
  signature_numerator: (s, v) => { s.sigNum = Number(v); },
  signature_denominator: (s, v) => { s.sigDen = Number(v); },
  loop: (s, v) => { s.loop = bool(v); },
  metronome: (s, v) => { s.metronome = bool(v); },
  song_length: (s, v) => { s.songLength = Number(v); },
  clip_trigger_quantization: (s, v) => { s.launchQuant = Number(v); },
};
// Listened per track (they change while playing). Name, color and group structure are read in bulk instead.
// Volume is NOT listened: AbletonOSC keys mixer listeners by track index and, once tracks move in the
// set, the old listener stays on the old track, re-listening fails with "Observer not connected" until
// Live restarts, and the stale one reports another track's volume. So volume is read with gets (readVolumes).
const TRACK_PROPS = ['mute', 'solo', 'playing_slot_index'] as const satisfies readonly TrackProp[];
const TRACK_DATA = ['name', 'color', 'is_foldable', 'group_track'] as const;
const TRACK_CHUNK = 40;

export const emptyLive = (): LiveState => ({
  playing: false, position: 0, tempo: 120, sigNum: 4, sigDen: 4, loop: false, metronome: false, songLength: 0, launchQuant: 4,
  cues: [], scenes: [], tracks: [],
});

/** Emits 'change' for anything but the playhead, and 'position' for playhead/transport ticks. */
export class LiveStore extends EventEmitter {
  state = emptyLive();
  private poll?: NodeJS.Timeout;
  private polls = 0;
  private polling = false;
  private osc: OscClient;
  private sceneTempo: { value: number; on: boolean }[] = [];

  constructor(osc: OscClient, pollMs = 2000) {
    super();
    this.osc = osc;
    osc.on('message', (address: string, args: Arg[]) => this.onMessage(address, args));
    osc.on('resync', () => void this.sync().catch(() => {}));
    osc.on('status', () => this.emit('change'));
    this.poll = setInterval(() => {
      if (osc.status !== 'connected' || this.polling) return; // a slow poll on a big set must not pile up
      this.polling = true;
      void this.pollSlow().catch(() => {}).finally(() => { this.polling = false; });
    }, pollMs);
  }

  stop() { clearInterval(this.poll); }

  /** Session: the scene most tracks are playing (Live has no "playing scene"), or -1. With `among`, only
   *  those scenes count, so tracks that keep looping their own clips (MIDI, click) don't win the vote. */
  playingScene(among?: Set<number>): number {
    const counts = new Map<number, number>();
    for (const t of this.state.tracks) {
      if (t.playingSlot >= 0 && (!among || among.has(t.playingSlot))) counts.set(t.playingSlot, (counts.get(t.playingSlot) ?? 0) + 1);
    }
    let best = -1;
    let n = 0;
    for (const [scene, c] of counts) if (c > n) { best = scene; n = c; }
    return best;
  }

  /** Session: the lowest scene waiting to launch, or -1. */
  triggeredScene = () => this.state.scenes.find((s) => s.triggered)?.index ?? -1;

  private onMessage(address: string, args: Arg[]) {
    const [, , obj, verb, prop] = address.split('/');
    if (verb !== 'get') return;
    if (obj === 'song') {
      const apply = SONG[prop as SongProp];
      if (!apply) return;
      apply(this.state, args[0] ?? null);
      this.emit(prop === 'current_song_time' || prop === 'is_playing' ? 'position' : 'change');
    } else if (obj === 'track' && (TRACK_PROPS as readonly string[]).includes(prop!)) { // volume pushes are ignored, see TRACK_PROPS
      const t = this.state.tracks[Number(args[0])];
      if (!t) return;
      const v = args[1];
      if (prop === 'name') t.name = String(v);
      else if (prop === 'mute' || prop === 'solo') t[prop] = bool(v);
      else if (prop === 'playing_slot_index') t.playingSlot = Number(v);
      else t[prop as 'volume' | 'color'] = Number(v);
      this.emit('change');
    } else if (obj === 'scene') {
      const i = Number(args[0]);
      const sc = this.state.scenes[i];
      const tempo = this.sceneTempo[i];
      if (!sc || !tempo) return;
      const v = args[1];
      if (prop === 'name') sc.name = String(v);
      else if (prop === 'color') sc.color = Number(v);
      else if (prop === 'is_empty') sc.isEmpty = bool(v);
      else if (prop === 'is_triggered') sc.triggered = bool(v);
      else if (prop === 'tempo') tempo.value = Number(v);
      else if (prop === 'tempo_enabled') tempo.on = bool(v);
      else return;
      sc.tempo = tempo.on ? tempo.value : null;
      this.emit('change');
    }
  }

  /** Sends a batch in chunks, waiting after each until Live has handled it (replies come back in
   *  order). A burst of 1000+ (one per track and property on a big set) queues up in AbletonOSC and
   *  delays every reply, scene launches included, by seconds. */
  private async sendMany(msgs: [string, ...Arg[]][]) {
    for (let i = 0; i < msgs.length; i += TRACK_CHUNK) {
      for (const [address, ...args] of msgs.slice(i, i + TRACK_CHUNK)) this.osc.send(address, ...args);
      await this.osc.request(OSC.app.test).catch(() => {});
    }
  }

  /** Name, color and group structure of every track, read in bulk from Live. */
  private async readTracks(n: number) {
    let changed = false;
    for (let lo = 0; lo < n; lo += TRACK_CHUNK) {
      const hi = Math.min(n, lo + TRACK_CHUNK);
      const k = TRACK_DATA.length;
      const v = await this.osc.request(OSC.song.trackData, [lo, hi, ...TRACK_DATA.map((p) => `track.${p}`)], (a) => a.length === (hi - lo) * k);
      for (let i = lo; i < hi; i++) {
        const t = this.state.tracks[i];
        if (!t) continue;
        const [name, color, fold, parent] = v.slice((i - lo) * k, (i - lo + 1) * k);
        const next = { name: String(name ?? ''), color: Number(color ?? 0), isGroup: bool(fold), parent: typeof parent === 'number' ? parent : -1 };
        if (t.name !== next.name || t.color !== next.color || t.isGroup !== next.isGroup || t.parent !== next.parent) { Object.assign(t, next); changed = true; }
      }
    }
    if (changed) this.emit('change');
  }

  /** Every track's volume, read with one get per track. Each reply is matched to its own request by
   *  track index, so unasked pushes from stale AbletonOSC volume listeners can't put a value on the wrong track. */
  private async readVolumes(n: number) {
    let changed = false;
    for (let lo = 0; lo < n; lo += TRACK_CHUNK) {
      const ids = Array.from({ length: Math.min(n, lo + TRACK_CHUNK) - lo }, (_, k) => lo + k);
      const vals = await Promise.all(ids.map((i) => this.osc.request(OSC.track.get('volume'), [i], (a) => a[0] === i).then((a) => Number(a[1])).catch(() => null)));
      ids.forEach((i, k) => {
        const t = this.state.tracks[i];
        const v = vals[k];
        if (t && v !== null && v !== undefined && Number.isFinite(v) && t.volume !== v) { t.volume = v; changed = true; }
      });
    }
    if (changed) this.emit('change');
  }

  /** Full refresh and (re)subscribe. Runs on every (re)connect and when AbletonOSC restarts. */
  async sync() {
    for (const p of Object.keys(SONG) as SongProp[]) {
      if (p === 'song_length') await this.osc.request(OSC.song.get(p));
      else this.osc.send(OSC.song.listen(p)); // listener replies with the current value at once
    }
    await this.pollSlow(true);
  }

  private async pollSlow(force = false) {
    this.polls++;
    const cueArgs = await this.osc.request(OSC.cue.list);
    const cues = [];
    for (let i = 0; i + 1 < cueArgs.length; i += 2) cues.push({ index: i / 2, name: String(cueArgs[i]), time: Number(cueArgs[i + 1]) });
    if (JSON.stringify(cues) !== JSON.stringify(this.state.cues)) { this.state.cues = cues; this.emit('change'); }

    // Scenes: rebuild when the count or names change; refresh is_empty now and then (no listener).
    const names = (await this.osc.request(OSC.song.sceneNames)).map(String);
    const scenesChanged = force || names.length !== this.state.scenes.length || names.some((n, i) => n !== this.state.scenes[i]!.name);
    if (scenesChanged) {
      this.state.scenes = names.map((name, index): Scene => ({ index, name, color: 0, tempo: null, isEmpty: false, triggered: false }));
      this.sceneTempo = names.map(() => ({ value: 120, on: false }));
      this.emit('change');
      await this.sendMany(names.flatMap((_, i) => [
        ...(['color', 'tempo', 'tempo_enabled'] as const).map((p): [string, Arg] => [OSC.scene.get(p), i]),
        [OSC.scene.listen('name'), i], [OSC.scene.listen('is_triggered'), i],
      ]));
    }
    if (scenesChanged || this.polls % 5 === 0) await this.sendMany(names.map((_, i) => [OSC.scene.get('is_empty'), i]));

    const n = Number((await this.osc.request(OSC.song.numTracks))[0]);
    // Same count: refresh names, colors and grouping now and then (Live has no listener for grouping).
    if (!force && n === this.state.tracks.length) {
      await this.readVolumes(n); // every poll (2 s): Live-side fader moves and automation show up within that
      if (this.polls % 5 === 0) await this.readTracks(n);
      return;
    }
    const old = this.state.tracks; // keep showing what we had while it refills
    this.state.tracks = Array.from({ length: n }, (_, index): Track => old[index] ?? ({
      index, name: '', mute: false, solo: false, volume: 0, color: 0, playingSlot: -1, isGroup: false, parent: -1,
    }));
    this.emit('change');
    await this.readTracks(n);
    await this.readVolumes(n);
    await this.sendMany(Array.from({ length: n }, (_, i) => TRACK_PROPS.map((p): [string, Arg] => [OSC.track.listen(p), i])).flat());
    await this.osc.request(OSC.song.get('song_length'));
    this.emit('change');
  }
}
