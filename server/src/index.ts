// SetDeck server: OSC bridge to Live, app state, WebSocket API, and static files for the built UI.

import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  beatsToSeconds, deriveSongs, marksFromSetup, neighbour, nextBar, parseCommand, playable, quantBeats, sessionSongs, songAt,
  type AppState, type Command, type Pending, type ServerMsg,
} from '@setdeck/shared';
import { OSC, type ClipProp } from './osc-map.ts';
import { OscClient, type OscOptions } from './osc-client.ts';
import { LiveStore } from './live.ts';
import { load, save, type Data } from './persist.ts';

export type ServerOptions = { httpPort?: number; osc?: OscOptions; webDir?: string };

export async function startServer(o: ServerOptions = {}) {
  const osc = new OscClient(o.osc);
  const live = new LiveStore(osc);
  const data: Data = load();
  let pending: Pending | null = null;

  const session = () => data.view === 'session';
  const viewMarks = () => (session() ? data.sessionMarks : data.marks);
  const markers = () => (session() ? live.state.scenes.map((s) => ({ index: s.index, name: s.name, time: s.index })) : live.state.cues);
  const songs = () => (session()
    ? sessionSongs(live.state.scenes, data.sessionMarks ?? [], data)
    : deriveSongs(live.state.cues, data.marks ?? [], live.state.songLength, data));

  // Session: where the performer is = playing scene, else the last one launched.
  let lastScene = -1;
  let songStartBeat: number | null = null;
  // Session: only scenes that are a song's sections count as "the playing scene".
  const songScenes = () => new Set(songs().flatMap((s) => s.sections.map((x) => x.start)));
  const playingScene = () => live.playingScene(songScenes());
  const at = () => { if (!session()) return live.state.position; const p = playingScene(); return p >= 0 ? p : lastScene; };
  const sessionPending = (): Pending | null => {
    const t = live.triggeredScene();
    if (t < 0) return null;
    const q = quantBeats(live.state.launchQuant, live.state.sigNum, live.state.sigDen) || 1;
    return { label: live.state.scenes[t]?.name || `Scene ${t + 1}`, target: t, atBeat: (Math.floor(live.state.position / q + 1e-9) + 1) * q };
  };
  const appState = (): AppState => ({
    connection: osc.status, view: data.view, live: live.state, setupDone: viewMarks() !== null, marks: viewMarks() ?? [],
    songs: songs(), pending: session() ? jumpPending ?? sessionPending() : pending, at: at(), songStartBeat, padMidi: data.padMidi,
  });

  // ---------- clients ----------
  const clients = new Set<WebSocket>();
  const sendAll = (m: ServerMsg) => { const s = JSON.stringify(m); for (const c of clients) if (c.readyState === c.OPEN) c.send(s); };
  let stateQueued = false;
  const pushState = () => {
    if (stateQueued) return;
    stateQueued = true;
    // ponytail: 30 ms coalescing, since a scene launch sends one message per track (hundreds).
    setTimeout(() => { stateQueued = false; sendAll({ type: 'state', state: appState() }); }, 30);
  };
  let lastPos = 0;
  let lastPlaying = false;
  const pushPos = () => {
    const now = performance.now();
    // ~30 updates/s is plenty for a playhead, but play/stop always goes out (a stop comes once, then no more updates)
    if (now - lastPos < 33 && live.state.playing === lastPlaying) return;
    lastPos = now;
    lastPlaying = live.state.playing;
    sendAll({ type: 'pos', position: live.state.position, playing: live.state.playing });
  };

  // ---------- jumps ----------
  // ponytail: queued jumps land on the next bar, fired from playhead updates with a small lookahead.
  // Prompt 3 replaces this with the full scheduler (beat/bar/section modes, measured latency).
  const LOOKAHEAD_BEATS = 0.05;
  const jumpNow = (beat: number) => { pending = null; osc.songSet('current_song_time', beat); live.state.position = beat; pushState(); };
  const queue = (beat: number, label: string, immediate?: boolean) => {
    if (immediate || !live.state.playing) return jumpNow(beat);
    pending = { label, target: beat, atBeat: nextBar(live.state.position, live.state.sigNum, live.state.sigDen) };
    pushState();
  };
  live.on('position', () => {
    if (pending && live.state.playing && live.state.position >= pending.atBeat - LOOKAHEAD_BEATS) jumpNow(pending.target);
    if (pending && !live.state.playing) { pending = null; pushState(); }
    pushPos();
  });
  // Session: launch a scene through Live (its launch quantization queues it). Immediate = launch
  // with quantization off for that one launch, then put the user's setting back.
  const fire = (scene: number, immediate?: boolean) => {
    lastScene = scene;
    // a scene launch replaces a clip jump still waiting for its bar (Live retriggers those slots too)
    if (jumpPending) { jumpPending = null; pushState(); }
    // starts a jump moved go back first; if those clips are playing, relaunch at once (waiting for the bar,
    // they would play from the moved-back start meanwhile)
    const back = data.restore.filter((r) => r.scene === scene);
    if (back.length && live.state.playing) immediate = true;
    putBack(back);
    if (!immediate) return osc.send(OSC.scene.fire, scene);
    const q = live.state.launchQuant;
    osc.songSet('clip_trigger_quantization', 0);
    osc.send(OSC.scene.fire, scene);
    osc.songSet('clip_trigger_quantization', q);
  };
  // Session: when a new song starts, note where (elapsed time) and apply an empty header scene's tempo.
  let lastSongId: string | undefined;
  live.on('change', () => {
    if (session()) {
      const playing = playingScene();
      if (playing >= 0) lastScene = playing;
      const song = playing >= 0 ? songAt(songs(), playing) : undefined;
      if (song && song.id !== lastSongId) {
        songStartBeat = live.state.position - jumpBeat; // a clip jump started this song part-way in
        jumpBeat = 0;
        void sceneClips(playing).then(follow).catch(() => {}); // read ahead for the pads (and the clip to follow)
        const head = live.state.scenes[song.start];
        if (head?.tempo != null && live.state.scenes[playing]?.tempo == null && head.isEmpty) osc.songSet('tempo', head.tempo);
      }
      if (playing >= 0) lastSongId = song?.id;
    }
    pushState();
  });

  const persist = () => { save(data); pushState(); };

  // ---------- session: jump inside a song's clips ----------
  // AbletonOSC can't move a playing clip's position. So a jump relaunches the song's scene from the jump
  // point: each unlooped clip's start (loop_start; Live 12 ignores start_marker there) moves by `beat`,
  // then the scene fires: one call, so every clip starts in the same audio buffer (fired one by one they
  // land ~20 ms apart and sound doubled). Looping clips restart with it. Each start goes back only once
  // its clip has stopped playing: putting it back while the clip plays pulls the playback back with it
  // (all checked on Live 12). The original starts are saved first, so a crash mid-song is undone later.
  // ponytail: saving the set in Live mid-song keeps the moved starts; SetDeck puts them back when the clips stop.
  let landAt = Infinity;
  let jumpBeat = 0;
  let jumpPending: Pending | null = null; // shown as queued until the clips launch
  const putBack = (rs: typeof data.restore) => {
    if (!rs.length) return;
    for (const r of rs) osc.send(OSC.clip.setStart, r.track, r.scene, r.start);
    data.restore = data.restore.filter((r) => !rs.includes(r));
    save(data);
  };
  // A jumped clip counts once Live plays it, and goes back when it stops (song stopped, or its track moved on).
  const settleStarts = () => {
    const { playing, tracks } = live.state;
    if (!data.restore.length || !tracks.length) return;
    for (const r of data.restore) if (playing && tracks[r.track]?.playingSlot === r.scene) r.on = true;
    putBack(data.restore.filter((r) => r.on && (!playing || tracks[r.track]?.playingSlot !== r.scene)));
  };
  osc.on('resync', () => { for (const r of data.restore) r.on = false; }); // seen playing again first (state is being re-read)
  live.on('change', settleStarts);
  live.on('position', () => {
    settleStarts();
    if (jumpPending && live.state.position >= landAt) { jumpPending = null; pushState(); }
  });
  const clipGet = (p: ClipProp, t: number, s: number) => osc.request(OSC.clip.get(p), [t, s], (a) => a[0] === t && a[1] === s).then((a) => a[2]);
  const yes = (v: unknown) => v === true || v === 1;
  // Clip info of a scene, read ahead (when its song plays, and refreshed every few seconds) so a pad press
  // goes straight to Live without asking about every clip first. Never read while a jump has its starts moved.
  type ClipInfo = { t: number; start: number; end: number; looping: boolean; beats: boolean; audio: boolean };
  const clipCache = new Map<number, { clips: ClipInfo[]; at: number }>();
  const moved = (scene: number) => data.restore.some((r) => r.scene === scene);
  async function sceneClips(scene: number, maxAge = 10_000): Promise<ClipInfo[]> {
    const hit = clipCache.get(scene);
    if ((hit && Date.now() - hit.at < maxAge) || moved(scene)) return hit?.clips ?? [];
    const n = live.state.tracks.length;
    if (!n) return []; // tracks not read yet (just connected): nothing to keep
    const has = await Promise.all(Array.from({ length: n }, (_, t) => osc.request(OSC.clipSlot.hasClip, [t, scene], (a) => a[0] === t && a[1] === scene)
      .then((a) => yes(a[2])).catch(() => false)));
    const clips = await Promise.all(has.flatMap((h, t) => (h ? [t] : [])).map(async (t): Promise<ClipInfo> => {
      const [start, end, looping, midi, warping] = await Promise.all(
        (['loop_start', 'loop_end', 'looping', 'is_midi_clip', 'warping'] as const).map((p) => clipGet(p, t, scene).catch(() => null)));
      return { t, start: Number(start), end: Number(end), looping: yes(looping), beats: yes(midi) || yes(warping), audio: !yes(midi) }; // unwarped audio: seconds
    }));
    if (moved(scene)) return clips; // a jump started meanwhile: these may be moved starts, don't keep them
    clipCache.set(scene, { clips, at: Date.now() });
    return clips;
  }
  setInterval(() => {
    const s = playingScene();
    if (session() && osc.status === 'connected' && s >= 0) void sceneClips(s).then(follow).catch(() => {});
  }, 3000).unref();

  // Session elapsed time, read from Live: the playing position of one of the song's clips (beats into it,
  // from its real start), so a restart or a jump can't throw it off. Followed while the song's first scene
  // plays; other scenes and unwarped-only songs fall back to the estimate made when the song started.
  let followed: { t: number; scene: number; start: number } | null = null;
  let heard = { pos: 0, at: 0 }; // the followed clip's last playing position, and when it came
  // Beats into the song's clips right now, while its first scene plays (null otherwise).
  const clipNow = (scene: number) => (live.state.playing && followed?.scene === scene && heard.at
    ? heard.pos - followed.start + ((performance.now() - heard.at) * live.state.tempo) / 60_000 : null);
  function follow() {
    const scene = session() && live.state.playing ? playingScene() : -1;
    const first = scene >= 0 && songAt(songs(), scene)?.sections[0]?.start === scene;
    const c = first ? clipCache.get(scene)?.clips.find((x) => !x.looping && x.beats) : undefined;
    if (followed?.t === c?.t && followed?.scene === scene) return;
    if (followed) osc.send(OSC.clip.unlisten('playing_position'), followed.t, followed.scene);
    followed = c ? { t: c.t, scene, start: c.start } : null;
    heard = { pos: 0, at: 0 };
    if (followed) osc.send(OSC.clip.listen('playing_position'), followed.t, scene);
  }
  live.on('change', follow);
  osc.on('resync', () => { followed = null; }); // listeners are gone: listen again
  osc.on('message', (address: string, args: unknown[]) => {
    if (!followed || !live.state.playing || address !== OSC.clip.get('playing_position') || args[0] !== followed.t || args[1] !== followed.scene) return;
    heard = { pos: Number(args[2]), at: performance.now() };
    const start = live.state.position - (heard.pos - followed.start);
    // ponytail: 0.25-beat dead band, so the two clocks' arrival jitter doesn't push state ~75 times a second
    if (songStartBeat === null || Math.abs(start - songStartBeat) > 0.25) { songStartBeat = start; pushState(); }
  });

  const START_APPLY_MS = 450;
  let jumpId = 0;
  async function clipJump(scene: number, beat: number, label: string, immediate?: boolean) {
    const id0 = ++jumpId;
    const clips = await sceneClips(scene, 60_000); // read ahead, with the original starts: no round trips here
    // The song is playing: Live moves each playing clip by the same amount (Clip.move_playing_pos), so the
    // stems stay together and nothing relaunches (a relaunch plays the old start for ~300 ms first, Live 12).
    if (id0 !== jumpId) return; // a newer press won while the clips were read
    const now = clipNow(scene);
    if (now !== null && immediate) {
      const by = beat - now;
      const old = live.state.launchQuant;
      osc.songSet('clip_trigger_quantization', 0); // at once, then the user's setting back
      for (const c of clips) if (!c.looping) osc.send(OSC.clip.move, c.t, scene, by);
      osc.songSet('clip_trigger_quantization', old);
      lastScene = scene;
      songStartBeat = live.state.position - beat;
      return pushState();
    }
    const jumps = clips
      .map((c) => ({ ...c, to: c.start + (c.beats ? beat : beatsToSeconds(beat, live.state.tempo)) }))
      .filter((c) => !c.looping && Number.isFinite(c.start) && c.to < c.end);
    if (!jumps.length) return;
    const ts = new Set(jumps.map((c) => c.t));
    data.restore = [...data.restore.filter((r) => r.scene !== scene || !ts.has(r.track)), ...jumps.map((c) => ({ track: c.t, scene, start: c.start }))];
    save(data);
    for (const c of jumps) osc.send(OSC.clip.setStart, c.t, scene, c.to);
    // Live applies a changed start 290-360 ms later (measured, Live 12); a launch before that plays the old
    // start first. So a launch from stop waits for it: a short silence, never the wrong part.
    // ponytail: fixed wait; a queued (on-the-bar) jump doesn't wait, so a bar due within ~0.4 s can still clash
    if (immediate) { await sleep(START_APPLY_MS); if (id0 !== jumpId) return; } // another pad pressed meanwhile
    const q = quantBeats(live.state.launchQuant, live.state.sigNum, live.state.sigDen);
    const quantized = !immediate && live.state.playing && q > 0;
    const old = live.state.launchQuant;
    if (immediate) osc.songSet('clip_trigger_quantization', 0); // launch now, then put the user's setting back
    osc.send(OSC.scene.fire, scene);
    // ponytail: a clip that ends before the jump point restarts from its own start with the scene; stop it here if stems of different lengths show up
    if (immediate) osc.songSet('clip_trigger_quantization', old);
    const at = quantized ? (Math.floor(live.state.position / q + 1e-9) + 1) * q : live.state.position;
    lastScene = scene;
    // elapsed time follows the jump: the song already playing, or the one this jump starts
    if (live.state.playing && songAt(songs(), playingScene())?.id === songAt(songs(), scene)?.id) songStartBeat = at - beat;
    else jumpBeat = beat;
    landAt = at + 0.5;
    jumpPending = quantized ? { label, target: scene, atBeat: at } : null;
    pushState();
  }

  function run(c: Command) {
    switch (c.type) {
      case 'play': {
        if (!session()) return osc.send(OSC.song.startPlaying);
        const list = songs();
        const target = list.flatMap((s) => s.sections).some((x) => x.start === lastScene) ? lastScene : playable(list, 'session').find((s) => !s.hidden)?.sections[0]?.start;
        return target !== undefined && fire(target);
      }
      case 'stop': pending = null; jumpPending = null; osc.send(OSC.song.stopPlaying); return putBack(data.restore); // after the stop
      case 'fire': return fire(c.scene, c.immediate);
      case 'setView': data.view = c.view; return persist();
      case 'cancel': pending = null; return pushState();
      case 'goto': return queue(c.beat, c.label, c.immediate);
      case 'next': case 'prev': {
        if (session()) {
          const t = live.triggeredScene();
          const s = neighbour(playable(songs(), 'session'), t >= 0 ? t : at(), c.type === 'next' ? 1 : -1); // skip songs with no clips
          const first = s?.sections[0];
          return first && fire(first.start, c.immediate);
        }
        const s = neighbour(songs(), pending?.target ?? live.state.position, c.type === 'next' ? 1 : -1);
        return s && queue(s.start, s.name, c.immediate);
      }
      case 'setTempo': return osc.songSet('tempo', c.bpm);
      case 'setup': {
        const marks = marksFromSetup(markers(), viewMarks() ?? [], c.cueKeys);
        if (session()) data.sessionMarks = marks; else data.marks = marks;
        return persist();
      }
      case 'reorder': data.order = c.ids; return persist();
      case 'hide':
        data.hidden = c.hidden ? [...new Set([...data.hidden, c.id])] : data.hidden.filter((h) => h !== c.id);
        return persist();
      case 'setWave':
        if (c.wave) data.waves[c.id] = c.wave; else delete data.waves[c.id];
        persist();
        return sendAll({ type: 'waves', waves: data.waves });
      case 'setTimers': data.songData[c.id] = { ...data.songData[c.id], timers: c.timers }; return persist();
      case 'setPadMidi': data.padMidi = c.pads; return persist();
      case 'clipJump': return void clipJump(c.scene, c.beat, c.label, c.immediate).catch(() => {});
      // Live's mute/solo are booleans; AbletonOSC sets them from 0/1.
      case 'mix': {
        osc.trackSet(c.prop, c.track, c.value);
        // Show it at once: volume has no listener (read every 2 s), mute/solo listeners confirm shortly.
        const t = live.state.tracks[c.track];
        if (t) { if (c.prop === 'volume') t.volume = c.value; else t[c.prop] = c.value === 1; pushState(); }
        return;
      }
    }
  }

  // ---------- HTTP + WebSocket ----------
  const dist = o.webDir ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
  const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
  // The song's audio stems, for the waveform: the UI decodes them (only the peaks come back, as setWave).
  // Files are only ever the ones Live reports for a clip slot.
  const api = async (path: string, res: http.ServerResponse) => {
    const [, kind, a, b] = path.split('/').slice(1); // api, stems|clip, scene|track, scene
    if (kind === 'stems' && Number.isInteger(Number(a))) {
      const scene = Number(a);
      const stems = (await sceneClips(scene, 60_000)).filter((c) => c.audio && !c.looping)
        .map((c) => ({ url: `/api/clip/${c.t}/${scene}`, start: c.start, end: c.end, beats: c.beats }));
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(stems));
    }
    const file = kind === 'clip' && Number.isInteger(Number(a)) && Number.isInteger(Number(b))
      ? await clipGet('file_path', Number(a), Number(b)).catch(() => null) : null;
    if (typeof file !== 'string' || !existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    createReadStream(file).pipe(res);
  };
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/')) return void api(req.url.split('?')[0]!, res).catch(() => res.writeHead(500).end());
    const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^(\.\.[/\\])+/, '');
    let f = join(dist, path);
    if (!f.startsWith(dist) || !existsSync(f) || statSync(f).isDirectory()) f = join(dist, 'index.html');
    if (!existsSync(f)) { res.writeHead(404).end('UI not built. In development, open the Vite URL (port 5173).'); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' });
    createReadStream(f).pipe(res);
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'state', state: appState() } satisfies ServerMsg));
    ws.send(JSON.stringify({ type: 'waves', waves: data.waves } satisfies ServerMsg));
    ws.on('close', () => clients.delete(ws));
    ws.on('message', (raw) => {
      let cmd: Command | null = null;
      try { cmd = parseCommand(JSON.parse(String(raw))); } catch { /* ignored below */ }
      if (cmd) run(cmd); else console.warn('Ignored invalid command:', String(raw).slice(0, 200));
    });
  });

  const httpPort = o.httpPort ?? 7300;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(httpPort, resolve); });
  osc.on('status', (s) => console.log(`Live connection: ${s}`));
  void osc.start();

  return {
    httpPort: (server.address() as { port: number }).port,
    osc, live, run, appState,
    close: () => { live.stop(); osc.close(); wss.close(); server.close(); for (const c of clients) c.terminate(); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const s = await startServer({ httpPort: env.HTTP_PORT ? Number(env.HTTP_PORT) : undefined, osc: { host: env.LIVE_HOST, port: env.LIVE_PORT ? Number(env.LIVE_PORT) : undefined, replyPort: env.REPLY_PORT ? Number(env.REPLY_PORT) : undefined } });
  console.log(`SetDeck server on http://localhost:${s.httpPort} (WebSocket /ws), Live at ${s.osc.host}:${s.osc.port}`);
}
