import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startMock, type MockSet } from '@setdeck/mock-live';
import { cueKey, type ServerMsg } from '@setdeck/shared';
import { startServer } from './index.ts';
import { OscClient } from './osc-client.ts';
import { OSC } from './osc-map.ts';

const set = JSON.parse(readFileSync(new URL('../../mock-live/sets/demo.json', import.meta.url), 'utf8')) as MockSet;
const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await sleep(20); }
};

let mock: Awaited<ReturnType<typeof startMock>>;
let app: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  process.env.SETDECK_HOME = mkdtempSync(join(tmpdir(), 'setdeck-'));
  mock = await startMock({ ...set, tempo: 240 }, { port: 21000, replyPort: 21001, tickMs: 10 });
  app = await startServer({ httpPort: 0, osc: { port: 21000, replyPort: 21001, timeoutMs: 500 } });
  await until(() => app.osc.status === 'connected' && app.live.state.cues.length > 0 && app.live.state.tracks.some((t) => t.name === 'Click'));
});
afterAll(() => { app.close(); mock.close(); });

it('OSC client: request/response and timeout on unknown addresses', async () => {
  // own mock: AbletonOSC always replies to one fixed port, and the app already holds 21001
  const m = await startMock(set, { port: 22000, replyPort: 22001 });
  const c = new OscClient({ port: 22000, replyPort: 22001, timeoutMs: 200 });
  await c.bind();
  expect(await c.request(OSC.app.test)).toEqual(['ok']);
  expect(await c.trackGet('name', 3)).toBe('Bass');
  await expect(c.request('/live/nope')).rejects.toThrow(/no reply/);
  c.close();
  m.close();
});

it('store mirrors Live: tempo, tracks, and listener updates', async () => {
  expect(app.live.state.tempo).toBe(240);
  expect(app.live.state.tracks.map((t) => t.name)).toContain('Vox Lead');
  // group structure, read in bulk from Live: RHYTHM is a group holding Drums, Perc and Bass
  await until(() => app.live.state.tracks[0]?.isGroup === true);
  const t = app.live.state.tracks;
  expect(t.filter((x) => x.parent === 0).map((x) => x.name)).toEqual(['Drums', 'Perc', 'Bass']);
  expect(t.find((x) => x.name === 'Click')?.parent).toBe(-1);
  // volume is read with gets (AbletonOSC's volume listeners break once tracks move): every track has one,
  // and a change made inside Live shows up without any listener
  await until(() => app.live.state.tracks.every((x) => x.volume > 0));
  mock.tracks[11]!.volume = 0.4;
  await until(() => Math.abs((app.live.state.tracks[11]?.volume ?? 0) - 0.4) < 1e-6, 6000); // OSC floats are 32-bit
  mock.tracks[0]!.mute = 1; // changed "inside Live": the store sees it through a listener after a set
  app.osc.trackSet('mute', 0, 1);
  await until(() => app.live.state.tracks[0]!.mute);
  app.run({ type: 'setTempo', bpm: 200 });
  await until(() => app.live.state.tempo === 200);
}, 12000);

it('setup derives songs and persists the choice', async () => {
  app.run({ type: 'setView', view: 'arrangement' });
  expect(app.appState().setupDone).toBe(false);
  const songCues = app.live.state.cues.filter((c) => ['Glass Harbor', 'Slow Satellite', 'Paper Lanterns'].includes(c.name));
  app.run({ type: 'setup', cueKeys: songCues.map(cueKey) });
  const s = app.appState();
  expect(s.songs.map((x) => x.name)).toEqual(['Glass Harbor', 'Slow Satellite', 'Paper Lanterns']);
  expect(s.songs[1]!.sections.map((x) => x.name)).toEqual(['Start', 'Intro', 'Verse', 'Chorus', 'Solo', 'Last Chorus']);
  const saved = JSON.parse(readFileSync(join(process.env.SETDECK_HOME!, 'setdeck.json'), 'utf8'));
  expect(saved.marks).toHaveLength(3);
});

it('next song is queued to the next bar while playing, and a websocket client can drive it', async () => {
  const ws = new WebSocket(`ws://localhost:${app.httpPort}/ws`);
  const msgs: ServerMsg[] = [];
  ws.on('message', (m) => msgs.push(JSON.parse(String(m))));
  await new Promise((r) => ws.on('open', r));
  await until(() => msgs.some((m) => m.type === 'state'));

  ws.send(JSON.stringify({ type: 'goto', beat: 0, label: 'start' })); // stopped: jumps at once
  ws.send(JSON.stringify({ type: 'play' }));
  await until(() => app.live.state.playing && app.live.state.position > 1);
  ws.send(JSON.stringify({ type: 'next' }));
  await until(() => app.appState().pending !== null);
  const { atBeat, target } = app.appState().pending!;
  expect(atBeat % 4).toBe(0);
  expect(target).toBe(192);
  await until(() => app.live.state.position >= 192 && app.live.state.position < 196);
  expect(app.appState().pending).toBeNull();
  expect(msgs.some((m) => m.type === 'pos')).toBe(true);

  ws.send(JSON.stringify({ type: 'stop' }));
  ws.send(JSON.stringify({ type: 'bogus' })); // ignored, server keeps running
  await until(() => !app.live.state.playing);
  // the client hears the stop too (Space toggles from what the client last heard)
  const heard = () => { for (const m of [...msgs].reverse()) { if (m.type === 'pos') return m.playing; if (m.type === 'state') return m.state.live.playing; } };
  await until(() => heard() === false);
  ws.close();
});

it('session: songs from scenes, NEXT launches the next song quantized, empty header tempo applied', async () => {
  app.run({ type: 'setView', view: 'session' });
  await until(() => app.live.state.scenes.length === 21 && app.live.state.scenes[14]!.isEmpty);
  app.run({ type: 'setup', cueKeys: ['Glass Harbor@0', 'Slow Satellite@8', 'PAPER LANTERNS@14'] });
  const s = app.appState();
  expect(s.songs.map((x) => x.name)).toEqual(['Glass Harbor', 'Slow Satellite', 'PAPER LANTERNS']);
  expect(s.songs[2]!.sections[0]).toEqual({ name: 'Intro', start: 15 }); // empty header skipped

  app.run({ type: 'play' }); // stopped: launches the first song at once
  await until(() => app.live.playingScene() === 0 && app.live.state.playing);
  app.run({ type: 'next' });
  await until(() => app.appState().pending?.target === 8);
  await until(() => app.live.playingScene() === 8);
  expect(app.live.state.tempo).toBe(84); // scene tempo
  app.run({ type: 'next' });
  await until(() => app.live.playingScene() === 15);
  await until(() => app.live.state.tempo === 96); // tempo from the empty PAPER LANTERNS header
  app.run({ type: 'stop' });
  await until(() => !app.live.state.playing);
});

it('session: a clip jump; in place while the song plays, else from a moved start that goes back once stopped', async () => {
  const elapsed = () => app.live.state.position - (app.appState().songStartBeat ?? NaN); // from the clip's own position in Live
  app.run({ type: 'fire', scene: 0 }); // Glass Harbor
  await until(() => app.live.playingScene() === 0 && app.live.state.playing);
  // queued (not a pad): relaunches from a moved start on the bar
  app.run({ type: 'clipJump', scene: 0, beat: 32, label: 'Chorus' });
  await until(() => app.appState().pending?.label === 'Chorus'); // queued until it lands
  await until(() => mock.clips.get('1:0')?.loop_start === 32);
  await until(() => app.appState().pending === null, 6000); // landed
  await until(() => elapsed() >= 32);
  // putting a start back while its clip plays would pull the playback back to it (Live 12): it waits
  await sleep(500);
  expect(mock.clips.get('1:0')?.loop_start).toBe(32);
  // a pad while the song plays: Live moves the playing clips there, at once (no relaunch, starts untouched)
  app.run({ type: 'clipJump', scene: 0, beat: 16, label: 'Verse', immediate: true });
  await until(() => elapsed() >= 16 && elapsed() < 20);
  expect(app.appState().pending).toBeNull();
  expect(mock.clips.get('1:0')?.loop_start).toBe(32);
  expect(mock.song.clip_trigger_quantization).toBe(4); // Live's launch quantization put back
  app.run({ type: 'fire', scene: 0 }); // relaunching the song: from its real start
  await until(() => mock.clips.get('1:0')?.loop_start === 0);
  app.run({ type: 'stop' });
  await until(() => !app.live.state.playing);
  // a pad while stopped: starts the song at that point; the start goes back once stopped
  app.run({ type: 'clipJump', scene: 0, beat: 16, label: 'Verse', immediate: true });
  await until(() => app.live.state.playing && elapsed() >= 16 && elapsed() < 20);
  app.run({ type: 'stop' });
  await until(() => !app.live.state.playing);
  await until(() => mock.clips.get('1:0')?.loop_start === 0);
  // started again from stop: Live's song time restarts at 0, and elapsed follows (it used to keep the old base)
  app.run({ type: 'fire', scene: 0 });
  await until(() => app.live.state.playing && app.live.state.position < 2);
  await until(() => elapsed() >= 0 && elapsed() < 2);
  app.run({ type: 'stop' });
  await until(() => !app.live.state.playing);
}, 15000);

it('serves the audio stems of a scene, for the waveform', async () => {
  const stems = await (await fetch(`http://localhost:${app.httpPort}/api/stems/0`)).json() as { url: string; end: number; beats: boolean }[];
  expect(stems.length).toBe(set.tracks.length); // the mock has an audio clip on every track
  expect(stems[0]).toMatchObject({ end: 256, beats: true });
  const file = Buffer.from(await (await fetch(`http://localhost:${app.httpPort}${stems[0]!.url}`)).arrayBuffer());
  expect(file.subarray(0, 4).toString()).toBe('RIFF');
  expect((await fetch(`http://localhost:${app.httpPort}/api/clip/0/14`)).status).toBe(404); // empty scene: no file
});

it('reports a lost connection and recovers', async () => {
  mock.close();
  await until(() => app.osc.status === 'no-reply', 8000); // 3 missed heartbeats
  mock = await startMock(set, { port: 21000, replyPort: 21001 });
  await until(() => app.osc.status === 'connected', 4000);
  await until(() => app.live.state.tempo === 120); // resynced from the new "Live"
}, 15000);
