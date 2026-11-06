// `npm run probe`: checks, one by one, which AbletonOSC features work against the open Live set.
// It changes the set (position, tempo, loop, track 0 mute/solo/volume/name) and restores every
// value it touched at the end. Use a test set: Live's undo history still records the changes.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { OSC, LIVE_PORT, REPLY_PORT, ABLETONOSC_VERIFIED_SHA } from './osc-map.ts';
import { OscClient, type Arg } from './osc-client.ts';

type Status = 'PASS' | 'FAIL' | 'INFO' | 'SKIP';
export type Row = { n: number; check: string; status: Status; detail: string };
export type CuePoint = { index: number; name: string; time: number };

// ---------- pure helpers (unit tested) ----------

export function parseCuePoints(args: Arg[]): CuePoint[] {
  const cues: CuePoint[] = [];
  for (let i = 0; i + 1 < args.length; i += 2) cues.push({ index: i / 2, name: String(args[i]), time: Number(args[i + 1]) });
  return cues;
}

const START = '<!-- probe:start -->';
const END = '<!-- probe:end -->';

export function replaceProbeBlock(doc: string, block: string): string {
  const fresh = `${START}\n${block.trim()}\n${END}`;
  const a = doc.indexOf(START);
  const b = doc.indexOf(END);
  if (a === -1 || b === -1 || b < a) return `${doc.trimEnd()}\n\n${fresh}\n`;
  return doc.slice(0, a) + fresh + doc.slice(b + END.length);
}

export function renderTable(rows: Row[]): string {
  const esc = (s: string) => s.replaceAll('|', '\\|');
  return ['| # | Check | Result | Detail |', '|---|---|---|---|', ...rows.map((r) => `| ${r.n} | ${r.check} | ${r.status} | ${esc(r.detail)} |`)].join('\n');
}

// ---------- the probe ----------

const near = (a: unknown, b: number, tol = 0.01) => typeof a === 'number' && Math.abs(a - b) <= tol;
const truthy = (v: unknown) => v === true || v === 1;
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

async function main() {
  const { values } = parseArgs({ options: { host: { type: 'string', default: '127.0.0.1' }, timeout: { type: 'string', default: '1500' } } });
  const osc = new OscClient({ host: values.host!, timeoutMs: Number(values.timeout) });
  const rows: Row[] = [];
  const add = (check: string, status: Status, detail: string) => {
    const r = { n: rows.length + 1, check, status, detail };
    rows.push(r);
    console.log(`${String(r.n).padStart(2)}. ${status.padEnd(4)}  ${check}: ${detail}`);
  };
  const step = async (check: string, fn: () => Promise<[Status, string]>) => {
    try { add(check, ...(await fn())); } catch (e) { add(check, 'FAIL', (e as Error).message); }
  };

  try {
    await osc.bind();
  } catch (e) {
    const busy = (e as NodeJS.ErrnoException).code === 'EADDRINUSE';
    console.error(busy ? `Port ${REPLY_PORT} is in use. Stop the SetDeck server (or any other OSC client) and run the probe again.` : String(e));
    process.exit(1);
  }

  console.log(`SetDeck probe: Live at ${values.host}:${LIVE_PORT}, listening on ${REPLY_PORT}.`);
  console.log('This changes the open set and restores it at the end. Use a test set.\n');

  let liveVersion = 'unknown';
  const restore: (() => void)[] = [];

  try { checks: {
    // 1. Connection
    try {
      const ok = await osc.request(OSC.app.test);
      const v = await osc.request(OSC.app.version).catch(() => null);
      if (v) liveVersion = `${v[0]}.${v[1]}`;
      add('Connection', ok[0] === 'ok' ? 'PASS' : 'FAIL', `/live/test replied ${JSON.stringify(ok[0])}, Live ${liveVersion}`);
    } catch {
      add('Connection', 'FAIL', 'No reply from AbletonOSC. Is Live open? Is AbletonOSC selected as a Control Surface in Settings > Link, Tempo & MIDI? See docs/setup.md.');
      break checks;
    }

    // Save everything the probe will touch, before touching it.
    const saved = {
      position: Number(await osc.songGet('current_song_time')),
      tempo: Number(await osc.songGet('tempo')),
      metronome: await osc.songGet('metronome'),
      loop: await osc.songGet('loop'),
      loopStart: Number(await osc.songGet('loop_start')),
      loopLength: Number(await osc.songGet('loop_length')),
    };
    restore.push(() => {
      osc.send(OSC.song.stopPlaying);
      osc.songSet('tempo', saved.tempo);
      osc.songSet('metronome', truthy(saved.metronome) ? 1 : 0);
      osc.songSet('loop_start', saved.loopStart);
      osc.songSet('loop_length', saved.loopLength);
      osc.songSet('loop', truthy(saved.loop) ? 1 : 0);
      osc.songSet('current_song_time', saved.position);
    });
    osc.send(OSC.song.stopPlaying);
    osc.songSet('loop', 0);
    await sleep(200);

    // 2. Cue points
    let cues: CuePoint[] = [];
    await step('Cue points', async () => {
      cues = parseCuePoints(await osc.request(OSC.cue.list));
      if (!cues.length) return ['FAIL', 'No locators in this set. Add some in Arrangement view (Create > Add Locator).'];
      const sorted = cues.every((c, i) => i === 0 || c.time >= cues[i - 1]!.time);
      for (const c of cues) console.log(`      [${c.index}] ${fmt(c.time).padStart(8)}  ${c.name}`);
      return ['PASS', `${cues.length} locators; Live returns them ${sorted ? 'sorted by time' : 'NOT sorted by time (app must sort)'}`];
    });

    // 3. Jump to cue while stopped
    await step('Jump to cue (stopped)', async () => {
      const target = cues[1] ?? cues[0];
      if (!target) return ['SKIP', 'needs a locator'];
      osc.songSet('current_song_time', target.time === 0 ? 4 : 0);
      await sleep(150);
      osc.send(OSC.cue.jump, target.index);
      await sleep(250);
      const pos = await osc.songGet('current_song_time');
      return [near(pos, target.time) ? 'PASS' : 'FAIL', `jumped to [${target.index}] "${target.name}" at ${fmt(target.time)}, position now ${pos}`];
    });

    // 4. Jump timing while playing (informational, feeds the Prompt 3 scheduler)
    await step('Jump timing (playing)', async () => {
      const quant = await osc.songGet('clip_trigger_quantization').catch(() => '?');
      const target = [...cues].reverse().find((c) => c.time >= 16);
      if (!target) return ['SKIP', 'needs a locator at beat 16 or later'];
      const results: string[] = [];
      for (const [how, doJump] of [
        ['cue_point/jump', () => osc.send(OSC.cue.jump, target.index)],
        ['set current_song_time', () => osc.songSet('current_song_time', target.time)],
      ] as const) {
        osc.songSet('current_song_time', 0);
        await sleep(150);
        osc.send(OSC.song.startPlaying);
        osc.send(OSC.song.listen('current_song_time'));
        await sleep(700); // let playback settle a little
        const samples = osc.collect(OSC.song.get('current_song_time'), 3000);
        await sleep(50);
        const tReq = performance.now();
        doJump();
        const s = await samples;
        osc.send(OSC.song.unlisten('current_song_time'));
        osc.send(OSC.song.stopPlaying);
        await sleep(200);
        const before = s.filter((x) => x.t <= tReq).at(-1);
        const landed = s.find((x) => x.t > tReq && Math.abs(Number(x.args[0]) - target.time) < 2);
        if (!landed) { results.push(`${how}: did not land on ${fmt(target.time)} within 3 s`); continue; }
        const ms = landed.t - tReq;
        results.push(`${how}: requested at beat ${before ? fmt(Number(before.args[0])) : '?'}, landed after ${ms.toFixed(0)} ms (${(ms / 60000 * saved.tempo).toFixed(2)} beats)`);
      }
      return ['INFO', `global quantization=${quant}; ${results.join('; ')}`];
    });

    // 5. Song position get/set
    await step('Song position get/set', async () => {
      osc.songSet('current_song_time', 8);
      await sleep(150);
      const pos = await osc.songGet('current_song_time');
      return [near(pos, 8) ? 'PASS' : 'FAIL', `set 8, read ${pos}`];
    });

    // 6. Play/stop
    await step('Play/stop', async () => {
      osc.songSet('current_song_time', 0);
      osc.send(OSC.song.startPlaying);
      await sleep(800);
      const playing = await osc.songGet('is_playing');
      const pos = Number(await osc.songGet('current_song_time'));
      osc.send(OSC.song.stopPlaying);
      await sleep(300);
      const stopped = await osc.songGet('is_playing');
      const ok = truthy(playing) && pos > 0 && !truthy(stopped);
      return [ok ? 'PASS' : 'FAIL', `is_playing=${playing} with position ${fmt(pos)} after 0.8 s, then is_playing=${stopped}`];
    });

    // 7. Loop get/set
    await step('Loop get/set', async () => {
      osc.songSet('loop_start', 4);
      osc.songSet('loop_length', 8);
      osc.songSet('loop', 1);
      await sleep(200);
      const [on, start, len] = [await osc.songGet('loop'), await osc.songGet('loop_start'), await osc.songGet('loop_length')];
      osc.songSet('loop', 0);
      const ok = truthy(on) && near(start, 4) && near(len, 8);
      return [ok ? 'PASS' : 'FAIL', `set loop on, start 4, length 8; read ${on}, ${start}, ${len}`];
    });

    // 8. Tempo get/set
    await step('Tempo get/set', async () => {
      const want = saved.tempo + 1;
      osc.songSet('tempo', want);
      await sleep(200);
      const got = await osc.songGet('tempo');
      osc.songSet('tempo', saved.tempo);
      return [near(got, want) ? 'PASS' : 'FAIL', `was ${fmt(saved.tempo)}, set ${fmt(want)}, read ${got}`];
    });

    // 9. Metronome get/set
    await step('Metronome get/set', async () => {
      const want = truthy(saved.metronome) ? 0 : 1;
      osc.songSet('metronome', want);
      await sleep(200);
      const got = await osc.songGet('metronome');
      osc.songSet('metronome', truthy(saved.metronome) ? 1 : 0);
      return [truthy(got) === (want === 1) ? 'PASS' : 'FAIL', `was ${saved.metronome}, set ${want}, read ${got}`];
    });

    // 10. Track names
    let numTracks = 0;
    await step('Track names', async () => {
      numTracks = Number(await osc.request(OSC.song.numTracks).then((a) => a[0]));
      const names = await osc.request(OSC.song.trackNames);
      if (!numTracks) return ['FAIL', 'No tracks in this set'];
      return ['PASS', `${numTracks} tracks: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''}`];
    });

    // 11 and 12 touch track 0. Save it (and every track's solo, since exclusive solo unsolos others).
    if (numTracks > 0) {
      const t0 = { name: String(await osc.trackGet('name', 0)), mute: await osc.trackGet('mute', 0), volume: Number(await osc.trackGet('volume', 0)) };
      const solos: Arg[] = [];
      for (let i = 0; i < numTracks; i++) solos.push(await osc.trackGet('solo', i));
      restore.push(() => {
        osc.trackSet('name', 0, t0.name);
        osc.trackSet('mute', 0, truthy(t0.mute) ? 1 : 0);
        osc.trackSet('volume', 0, t0.volume);
        solos.forEach((s, i) => osc.trackSet('solo', i, truthy(s) ? 1 : 0));
      });

      await step('Track mute/solo/volume', async () => {
        const out: string[] = [];
        let ok = true;
        for (const p of ['mute', 'solo'] as const) {
          const want = truthy(p === 'mute' ? t0.mute : solos[0]) ? 0 : 1;
          osc.trackSet(p, 0, want);
          await sleep(150);
          const got = await osc.trackGet(p, 0);
          ok &&= truthy(got) === (want === 1);
          out.push(`${p} set ${want} read ${got}`);
        }
        const vol = t0.volume > 0.5 ? 0.4 : 0.6;
        osc.trackSet('volume', 0, vol);
        await sleep(150);
        const gotVol = await osc.trackGet('volume', 0);
        ok &&= near(gotVol, vol, 0.001);
        out.push(`volume set ${vol} read ${typeof gotVol === 'number' ? gotVol.toFixed(3) : gotVol}`);
        osc.trackSet('mute', 0, truthy(t0.mute) ? 1 : 0);
        osc.trackSet('solo', 0, truthy(solos[0]) ? 1 : 0);
        osc.trackSet('volume', 0, t0.volume);
        return [ok ? 'PASS' : 'FAIL', `track 0 "${t0.name}": ${out.join(', ')}`];
      });

      await step('Track rename', async () => {
        osc.trackSet('name', 0, 'SetDeck probe');
        await sleep(150);
        const got = await osc.trackGet('name', 0);
        osc.trackSet('name', 0, t0.name);
        await sleep(150);
        const back = await osc.trackGet('name', 0);
        return [got === 'SetDeck probe' && back === t0.name ? 'PASS' : 'FAIL', `renamed to "${got}", restored to "${back}"`];
      });
    } else {
      add('Track mute/solo/volume', 'SKIP', 'no tracks');
      add('Track rename', 'SKIP', 'no tracks');
    }
    // The mixer's group layout needs Live's group structure, read in bulk.
    await step('Group tracks (track_data group_track)', async () => {
      if (!numTracks) return ['SKIP', 'no tracks'];
      const n = Math.min(numTracks, 40);
      const v = await osc.request(OSC.song.trackData, [0, n, 'track.is_foldable', 'track.group_track']);
      if (v.length !== n * 2) return ['FAIL', `expected ${n * 2} values, got ${v.length}`];
      const groups = v.filter((x, i) => i % 2 === 0 && (x === true || x === 1)).length;
      const inside = v.filter((x, i) => i % 2 === 1 && typeof x === 'number').length;
      return ['PASS', `${groups} group tracks, ${inside} tracks inside a group (first ${n} tracks)`];
    });

    // 13 + 14. Output meters and position listener rate, both measured during 2 s of playback
    {
      const from = cues[1]?.time ?? 0;
      osc.songSet('current_song_time', from);
      osc.send(OSC.song.startPlaying);
      for (let i = 0; i < numTracks; i++) osc.send(OSC.track.listen('output_meter_level'), i);
      osc.send(OSC.song.listen('current_song_time'));
      await sleep(300);
      const [meters, positions] = await Promise.all([osc.collect(OSC.track.get('output_meter_level'), 2000), osc.collect(OSC.song.get('current_song_time'), 2000)]);
      for (let i = 0; i < numTracks; i++) osc.send(OSC.track.unlisten('output_meter_level'), i);
      osc.send(OSC.song.unlisten('current_song_time'));
      osc.send(OSC.song.stopPlaying);
      await sleep(200);

      if (!numTracks) add('Output meters', 'SKIP', 'no tracks');
      else {
        const max = Math.max(0, ...meters.map((m) => Number(m.args[1])));
        const status: Status = !meters.length ? 'FAIL' : max > 0 ? 'PASS' : 'INFO';
        add('Output meters', status, meters.length
          ? `${meters.length} updates in 2 s across ${numTracks} tracks, peak ${max.toFixed(3)}${max > 0 ? '' : ' (all silent: play from a spot with audio and re-run)'}`
          : 'listener sent no updates');
      }
      const gaps = positions.slice(1).map((p, i) => p.t - positions[i]!.t).sort((a, b) => a - b);
      const median = gaps[Math.floor(gaps.length / 2)];
      add('Position listener rate', positions.length ? 'INFO' : 'FAIL', positions.length
        ? `${(positions.length / 2).toFixed(0)} updates/s, median gap ${median?.toFixed(1) ?? '?'} ms, worst ${gaps.at(-1)?.toFixed(1) ?? '?'} ms`
        : 'start_listen/current_song_time sent no updates while playing');
    }

    // 15. Arrangement clips
    if (numTracks > 0) {
      await step('Arrangement clips', async () => {
        const starts = (await osc.request(OSC.track.arrangementClipStarts, [0], (a) => a[0] === 0)).slice(1);
        return ['INFO', `track 0 has ${starts.length} arrangement clips (starts: ${starts.slice(0, 8).map((s) => fmt(Number(s))).join(', ')}${starts.length > 8 ? ', …' : ''}). Pitch/warp not exposed by AbletonOSC (Prompt 6).`];
      });
    } else add('Arrangement clips', 'SKIP', 'no tracks');
  } } finally {
    for (const r of restore.reverse()) r();
    await sleep(300);
    osc.close();
  }

  // Report
  const table = renderTable(rows);
  console.log(`\n${table}\n`);
  const compatPath = fileURLToPath(new URL('../../docs/compat.md', import.meta.url));
  const block = `## Latest probe run\n\n${new Date().toLocaleString('sv-SE').slice(0, 16)} · Live ${liveVersion} · AbletonOSC source verified at ${ABLETONOSC_VERIFIED_SHA}\n\n${table}`;
  const doc = existsSync(compatPath) ? readFileSync(compatPath, 'utf8') : '# Compatibility\n';
  writeFileSync(compatPath, replaceProbeBlock(doc, block));
  console.log('Results written to docs/compat.md');
  process.exitCode = rows.some((r) => r.status === 'FAIL') ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
