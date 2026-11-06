// UDP OSC mock that behaves like AbletonOSC for every address in server/src/osc-map.ts.
// Holds a fake set (from JSON) and a transport clock that advances in beats at the current tempo.
// Like the real script: replies to the sender's IP on the reply port, same address as the request,
// and stays silent on unknown addresses.

import dgram from 'node:dgram';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Message, encode, decode } from 'node-osc';
import { quantBeats } from '@setdeck/shared';

type Arg = string | number | boolean | null;

/** Every mock audio clip plays this file: a mono 16-bit WAV with a swelling tone, so a waveform has a shape. */
function stemFile(seconds: number, rate = 8000): string {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 9) * (0.2 + 0.8 * Math.abs(Math.sin(i / (rate * 8)))) * 30000), 44 + i * 2);
  const f = join(mkdtempSync(join(tmpdir(), 'mock-live-')), 'stem.wav');
  writeFileSync(f, b);
  return f;
}

export type MockSet = {
  tempo: number;
  signature: [number, number];
  songLength?: number;
  cuePoints: { name: string; time: number }[];
  /** group: a group track; parent: index of the group track it sits in. */
  tracks: { name: string; color: number; group?: boolean; parent?: number }[];
  /** Session view. Every track has a clip in every non-empty scene. */
  scenes?: { name: string; tempo?: number; empty?: boolean }[];
};

export type MockOptions = { port?: number; replyPort?: number; tickMs?: number };

export function startMock(set: MockSet, o: MockOptions = {}) {
  const port = o.port ?? 11000;
  const replyPort = o.replyPort ?? 11001;
  const tickMs = o.tickMs ?? 20;

  const song: Record<string, number> = {
    current_song_time: 0,
    is_playing: 0,
    tempo: set.tempo,
    signature_numerator: set.signature[0],
    signature_denominator: set.signature[1],
    loop: 0,
    loop_start: 0,
    loop_length: 16,
    metronome: 0,
    clip_trigger_quantization: 4, // 1 Bar
    song_length: set.songLength ?? Math.max(0, ...set.cuePoints.map((c) => c.time)) + 64,
  };
  const SONG_RW = new Set(['current_song_time', 'tempo', 'signature_numerator', 'signature_denominator', 'loop', 'loop_start', 'loop_length', 'metronome', 'clip_trigger_quantization']);
  const cues = set.cuePoints.map((c) => ({ ...c }));
  const tracks = set.tracks.map((t) => ({ name: t.name, color: t.color, mute: 0, solo: 0, volume: 0.85, is_foldable: t.group ? 1 : 0, group_track: t.parent ?? null }));
  type TrackKey = 'name' | 'color' | 'mute' | 'solo' | 'volume';
  const TRACK_RW = new Set(['name', 'color', 'mute', 'solo', 'volume']);
  const scenes = (set.scenes ?? []).map((sc) => ({
    name: sc.name, color: 0, tempo: sc.tempo ?? 120, tempo_enabled: sc.tempo ? 1 : 0, is_empty: sc.empty ? 1 : 0, is_triggered: 0,
  }));
  type SceneKey = keyof (typeof scenes)[number];
  let playingScene = -1;
  let fired: { scene: number; at: number } | null = null;
  const sceneListeners = new Set<string>(); // `${prop}:${index}`

  const songListeners = new Set<string>();
  const trackListeners = new Set<string>(); // `${prop}:${index}`
  let client: { address: string; port: number } | null = null;
  const sock = dgram.createSocket('udp4');

  const send = (address: string, args: Arg[]) => {
    if (!client) return;
    const m = new Message(address);
    for (const a of args) m.append(a); // append() encodes null as an OSC nil (like Python None); the constructor does not
    sock.send(encode(m), client.port, client.address);
  };
  const songValue = (p: string): Arg => (p === 'is_playing' || p === 'loop' || p === 'metronome' ? Boolean(song[p]) : song[p]!);
  const meter = (i: number) => (song.is_playing && !tracks[i]!.mute ? 0.4 + 0.4 * Math.abs(Math.sin(song.current_song_time! * 3 + i)) : 0);
  const trackValue = (p: string, i: number): Arg => {
    const t = tracks[i]!;
    if (p.startsWith('output_meter')) return meter(i);
    if (p === 'playing_slot_index') return playingScene;
    if (p === 'fired_slot_index') return fired?.scene ?? -1;
    if (p === 'mute' || p === 'solo' || p === 'is_foldable') return Boolean(t[p]);
    return t[p as TrackKey];
  };
  const setSong = (p: string, v: number) => {
    song[p] = v;
    if (songListeners.has(p)) send(`/live/song/get/${p}`, [songValue(p)]);
  };
  const notifyTracks = (p: string) => tracks.forEach((_, i) => { if (trackListeners.has(`${p}:${i}`)) send(`/live/track/get/${p}`, [i, trackValue(p, i)]); });
  const setScene = (i: number, p: SceneKey, v: string | number) => {
    (scenes[i] as Record<SceneKey, string | number>)[p] = v;
    if (sceneListeners.has(`${p}:${i}`)) send(`/live/scene/get/${p}`, [i, sceneValue(p, i)]);
  };
  const sceneValue = (p: string, i: number): Arg => {
    const v = scenes[i]![p as SceneKey];
    return p === 'is_empty' || p === 'is_triggered' || p === 'tempo_enabled' ? Boolean(v) : v;
  };
  // Like Live: a launched scene starts at once when stopped, otherwise at the next quantization step.
  let launchedAt = 0; // song time the playing scene's clips launched at
  const launch = (i: number) => {
    if (fired) setScene(fired.scene, 'is_triggered', 0);
    fired = null;
    launchedAt = song.current_song_time!;
    tracks.forEach((_, t) => { if (hasClip(t, i)) clip(t, i).from = clip(t, i).loop_start!; });
    playingScene = scenes[i]!.is_empty ? -1 : i; // an empty scene stops all clips
    if (scenes[i]!.tempo_enabled) setSong('tempo', scenes[i]!.tempo);
    notifyTracks('playing_slot_index');
    notifyTracks('fired_slot_index');
  };
  const fireScene = (i: number) => {
    if (!scenes[i]) return;
    const q = quantBeats(song.clip_trigger_quantization!, song.signature_numerator!, song.signature_denominator!);
    // from stop, Live's song time starts again at 0 (and says so after the clips have launched)
    if (!song.is_playing) { launch(i); setSong('is_playing', 1); setSong('current_song_time', 0); launchedAt = 0; return; }
    if (q === 0) return launch(i);
    if (fired) setScene(fired.scene, 'is_triggered', 0);
    fired = { scene: i, at: (Math.floor(song.current_song_time! / q + 1e-9) + 1) * q };
    setScene(i, 'is_triggered', 1);
    notifyTracks('fired_slot_index');
  };

  // Session clips: a clip in every non-empty scene on every track, unlooped. Like Live 12, an unlooped
  // clip's start is loop_start (start_marker can't be set there). Positions in beats; launching a clip
  // slot launches its scene (the mock plays scenes, not single clips), quantized like Live.
  const clips = new Map<string, Record<string, number>>();
  let stem: string | undefined; // written on first use
  const clipListeners = new Set<string>(); // `${track}:${scene}`, playing_position
  const playingPosition = (t: number, s: number) => (song.is_playing && s === playingScene ? (clip(t, s).from ?? 0) + song.current_song_time! - launchedAt : 0);
  const hasClip = (t: number, s: number) => !!tracks[t] && !!scenes[s] && !scenes[s].is_empty;
  const clip = (t: number, s: number) => {
    const k = `${t}:${s}`;
    if (!clips.has(k)) clips.set(k, { loop_start: 0, loop_end: 256, looping: 0, is_midi_clip: 0, warping: 1 });
    return clips.get(k)!;
  };

  function handle(address: string, args: Arg[]) {
    const [, , obj, verb, prop] = address.split('/'); // '', 'live', obj, verb, prop
    if (address === '/live/test') return send(address, ['ok']);
    if (address === '/live/application/get/version') return send(address, [12, 1]);

    if (obj === 'song') {
      if (verb === 'get' && prop! in song) return send(address, [songValue(prop!)]);
      if (verb === 'set' && SONG_RW.has(prop!)) return setSong(prop!, Number(args[0]));
      if (verb === 'start_listen' && prop! in song) { songListeners.add(prop!); return send(`/live/song/get/${prop}`, [songValue(prop!)]); }
      if (verb === 'stop_listen') return void songListeners.delete(prop!);
      switch (address) {
        case '/live/song/start_playing': case '/live/song/continue_playing': return setSong('is_playing', 1);
        case '/live/song/stop_playing': {
          setSong('is_playing', 0);
          if (fired) setScene(fired.scene, 'is_triggered', 0);
          fired = null;
          playingScene = -1;
          notifyTracks('playing_slot_index');
          return;
        }
        case '/live/song/get/num_scenes': return send(address, [scenes.length]);
        case '/live/song/get/scenes/name': return send(address, scenes.map((x) => x.name));
        case '/live/song/jump_by': return setSong('current_song_time', Math.max(0, song.current_song_time! + Number(args[0])));
        case '/live/song/get/cue_points': return send(address, cues.flatMap((c) => [c.name, c.time]));
        case '/live/song/get/num_tracks': return send(address, [tracks.length]);
        case '/live/song/get/track_names': return send(address, tracks.map((t) => t.name));
        case '/live/song/get/track_data': {
          const [lo, hi, ...props] = args as [number, number, ...string[]];
          const end = hi === -1 ? tracks.length : Math.min(hi, tracks.length);
          const out: Arg[] = [];
          for (let i = lo; i < end; i++) for (const p of props) out.push(trackValue(p.replace('track.', ''), i));
          return send(address, out);
        }
        case '/live/song/jump_to_next_cue': {
          const c = [...cues].sort((a, b) => a.time - b.time).find((c) => c.time > song.current_song_time! + 1e-6);
          return c && setSong('current_song_time', c.time);
        }
        case '/live/song/jump_to_prev_cue': {
          const c = [...cues].sort((a, b) => b.time - a.time).find((c) => c.time < song.current_song_time! - 1e-6);
          return c && setSong('current_song_time', c.time);
        }
        case '/live/song/cue_point/jump': {
          const c = typeof args[0] === 'string' ? cues.find((c) => c.name === args[0]) : cues[Number(args[0])];
          return c && setSong('current_song_time', c.time);
        }
      }
      return;
    }

    if (obj === 'clip_slot' || obj === 'clip') {
      const t = Number(args[0]);
      const s = Number(args[1]);
      if (obj === 'clip_slot' && verb === 'get' && prop === 'has_clip') return send(address, [t, s, hasClip(t, s)]);
      if (!hasClip(t, s)) return; // AbletonOSC raises on an empty slot and sends nothing
      if (obj === 'clip_slot' && verb === 'fire') return fireScene(s);
      const c = clip(t, s);
      if (prop === 'playing_position' && verb !== 'get') { // the clips of the playing scene play from where they launched
        if (verb === 'start_listen') { clipListeners.add(`${t}:${s}`); return send('/live/clip/get/playing_position', [t, s, playingPosition(t, s)]); }
        return void clipListeners.delete(`${t}:${s}`);
      }
      if (verb === 'get' && prop === 'playing_position') return send(address, [t, s, playingPosition(t, s)]);
      if (verb === 'move_playing_pos') { if (song.is_playing && s === playingScene) c.from = (c.from ?? 0) + Number(args[2]); return; }
      if (verb === 'get' && prop === 'file_path') return send(address, [t, s, (stem ??= stemFile((c.loop_end! * 60) / set.tempo))]); // warped at the set's tempo
      if (verb === 'get' && prop! in c) return send(address, [t, s, prop === 'loop_start' || prop === 'loop_end' ? c[prop]! : Boolean(c[prop!])]);
      if (verb === 'set' && prop === 'loop_start') { c.loop_start = Number(args[2]); return; }
      return;
    }

    if (obj === 'scene') {
      const i = Number(args[0]);
      if (!scenes[i]) return;
      if (verb === 'fire') return fireScene(i);
      if (verb === 'get' && prop! in scenes[i]!) return send(address, [i, sceneValue(prop!, i)]);
      if (verb === 'set' && prop! in scenes[i]! && prop !== 'is_empty' && prop !== 'is_triggered') return setScene(i, prop as SceneKey, prop === 'name' ? String(args[1]) : Number(args[1]));
      if (verb === 'start_listen' && (prop === 'name' || prop === 'is_triggered')) { sceneListeners.add(`${prop}:${i}`); return send(`/live/scene/get/${prop}`, [i, sceneValue(prop, i)]); }
      return;
    }

    if (obj === 'track') {
      const i = Number(args[0]);
      if (!tracks[i]) return; // AbletonOSC raises and sends nothing
      if (verb === 'get' && prop === 'arrangement_clips') return send(address, [i]);
      if (verb === 'get') return send(address, [i, trackValue(prop!, i)]);
      if (verb === 'set' && TRACK_RW.has(prop!)) {
        const t = tracks[i]! as Record<TrackKey, string | number>;
        t[prop as TrackKey] = prop === 'name' ? String(args[1]) : Number(args[1]);
        if (trackListeners.has(`${prop}:${i}`)) send(`/live/track/get/${prop}`, [i, trackValue(prop!, i)]);
        return;
      }
      if (verb === 'start_listen') { trackListeners.add(`${prop}:${i}`); return send(`/live/track/get/${prop}`, [i, trackValue(prop!, i)]); }
      if (verb === 'stop_listen') return void trackListeners.delete(`${prop}:${i}`);
    }
  }

  sock.on('message', (buf, rinfo) => {
    let msg;
    try { msg = decode(buf); } catch { return; }
    if (msg.oscType !== 'message') return;
    client = { address: rinfo.address, port: replyPort };
    handle(msg.address, msg.args.map((a: { value: Arg }) => a.value));
  });

  let last = performance.now();
  const clock = setInterval(() => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    if (!song.is_playing) return;
    let pos = song.current_song_time! + (dt * song.tempo!) / 60;
    const loopEnd = song.loop_start! + song.loop_length!;
    if (song.loop && song.current_song_time! < loopEnd && pos >= loopEnd) pos = song.loop_start! + (pos - loopEnd);
    setSong('current_song_time', pos);
    if (fired && pos >= fired.at) launch(fired.scene);
    for (const key of clipListeners) { const [t, s] = key.split(':').map(Number); send('/live/clip/get/playing_position', [t!, s!, playingPosition(t!, s!)]); }
    for (const key of trackListeners) {
      const [p, i] = key.split(':');
      if (p!.startsWith('output_meter')) send(`/live/track/get/${p}`, [Number(i), meter(Number(i))]);
    }
  }, tickMs);

  return new Promise<{ close: () => void; song: typeof song; tracks: typeof tracks; cues: typeof cues; scenes: typeof scenes; clips: typeof clips; playing: () => number }>((resolve, reject) => {
    sock.once('error', (e) => { clearInterval(clock); reject(e); });
    sock.bind(port, () => {
      // Like AbletonOSC: announce startup to the default remote (localhost, reply port), so a client
      // that was already running knows to resubscribe.
      sock.send(encode(new Message('/live/startup')), replyPort, '127.0.0.1');
      resolve({ close: () => { clearInterval(clock); sock.close(); }, song, tracks, cues, scenes, clips, playing: () => playingScene });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] ?? new URL('../sets/demo.json', import.meta.url).pathname;
  const set = JSON.parse(readFileSync(file, 'utf8')) as MockSet;
  const port = Number(process.env.LIVE_PORT ?? 11000);
  try {
    await startMock(set, { port, replyPort: Number(process.env.REPLY_PORT ?? 11001) });
  } catch (e) {
    console.error(`Mock Live could not use UDP ${port}: ${(e as Error).message}. Is real Live (AbletonOSC) running on it?`);
    process.exit(1);
  }
  console.log(`Mock Live listening on UDP ${port} with ${set.scenes?.length ?? 0} scenes, ${set.cuePoints.length} locators and ${set.tracks.length} tracks (${file})`);
}
