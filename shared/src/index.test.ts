import { describe, expect, it } from 'vitest';
import { cueKey, deriveSongs, formatBarBeat, formatTime, marksFromSetup, neighbour, nextBar, parseCommand, parseMidi, playable, quantBeats, sessionSongs, type Cue, type Scene } from './index.ts';

const cues: Cue[] = [
  { index: 0, name: 'A', time: 0 },
  { index: 1, name: 'Verse', time: 16 },
  { index: 2, name: 'B', time: 64 },
  { index: 3, name: 'Intro', time: 64 + 0 },
  { index: 4, name: 'C', time: 128 },
];
const none = { order: [], hidden: [], songData: {} };

describe('deriveSongs', () => {
  it('marked cues start songs, the rest are sections of the song before', () => {
    const songs = deriveSongs(cues, ['A@0', 'B@64', 'C@128'], 160, none);
    expect(songs.map((s) => [s.name, s.start, s.end])).toEqual([['A', 0, 64], ['B', 64, 128], ['C', 128, 160]]);
    expect(songs[0]!.sections.map((s) => s.name)).toEqual(['Start', 'Verse']);
    expect(songs[1]!.sections.map((s) => s.name)).toEqual(['Intro']); // section at the song start: no 'Start'
  });
  it('a moved locator keeps its song (matched by name) and per-song data', () => {
    const moved = cues.map((c) => (c.name === 'B' ? { ...c, time: 72 } : c));
    const songs = deriveSongs(moved, ['A@0', 'B@64'], 160, { order: [], hidden: [], songData: { 'B@64': { bpm: 98 } } });
    expect(songs[1]).toMatchObject({ id: 'B@64', name: 'B', start: 72, bpm: 98 });
  });
  it('applies saved order and hidden flags; unknown songs go last in time order', () => {
    const songs = deriveSongs(cues, ['A@0', 'B@64', 'C@128'], 160, { order: ['C@128', 'A@0'], hidden: ['A@0'], songData: {} });
    expect(songs.map((s) => s.name)).toEqual(['C', 'A', 'B']);
    expect(songs[1]!.hidden).toBe(true);
  });
});

it('marksFromSetup keeps the old mark for a song that moved', () => {
  const moved = cues.map((c) => (c.name === 'B' ? { ...c, time: 72 } : c));
  expect(marksFromSetup(moved, ['B@64'], ['A@0', cueKey({ name: 'B', time: 72 })])).toEqual(['A@0', 'B@64']);
});

it('neighbour walks the visible setlist from the song under the playhead', () => {
  const songs = deriveSongs(cues, ['A@0', 'B@64', 'C@128'], 160, { order: [], hidden: ['B@64'], songData: {} });
  expect(neighbour(songs, 10, 1)?.name).toBe('C');
  expect(neighbour(songs, 130, -1)?.name).toBe('A');
  expect(neighbour(songs, 130, 1)).toBeUndefined();
});

it('time helpers', () => {
  expect(nextBar(0, 4, 4)).toBe(4);
  expect(nextBar(3.99, 4, 4)).toBe(4);
  expect(nextBar(4, 4, 4)).toBe(8);
  expect(nextBar(1, 6, 8)).toBe(3); // 6/8 bar = 3 quarter beats
  expect(formatBarBeat(0, 4, 4)).toBe('1.1');
  expect(formatBarBeat(5.5, 4, 4)).toBe('2.2');
  expect(formatBarBeat(3, 6, 8)).toBe('2.1');
  expect(formatTime(65)).toBe('1:05');
  expect(formatTime(3725)).toBe('1:02:05');
});

it('parseCommand rejects malformed input', () => {
  expect(parseCommand({ type: 'goto', beat: 8, label: 'x' })).toEqual({ type: 'goto', beat: 8, label: 'x', immediate: undefined });
  expect(parseCommand({ type: 'goto', beat: -1, label: 'x' })).toBeNull();
  expect(parseCommand({ type: 'setTempo', bpm: 'fast' })).toBeNull();
  expect(parseCommand({ type: 'rm -rf' })).toBeNull();
  expect(parseCommand(null)).toBeNull();
  expect(parseCommand({ type: 'fire', scene: 2.5 })).toBeNull();
  expect(parseCommand({ type: 'setView', view: 'clip' })).toBeNull();
});

it('parseCommand: timers are sorted, waves and mix values are range-checked', () => {
  expect(parseCommand({ type: 'setTimers', id: 's', timers: [{ name: 'Chorus', beat: 32 }, { name: 'Intro', beat: 0, x: 1 }] }))
    .toEqual({ type: 'setTimers', id: 's', timers: [{ name: 'Intro', beat: 0 }, { name: 'Chorus', beat: 32 }] });
  expect(parseCommand({ type: 'setTimers', id: 's', timers: [{ name: 'X', beat: -4 }] })).toBeNull();
  expect(parseCommand({ type: 'setWave', id: 's', wave: { peaks: [0, 50, 99], seconds: 10, bpm: 120 } })).not.toBeNull();
  expect(parseCommand({ type: 'setWave', id: 's', wave: { peaks: [120], seconds: 10, bpm: 120 } })).toBeNull();
  expect(parseCommand({ type: 'setWave', id: 's', wave: null })).toEqual({ type: 'setWave', id: 's', wave: null });
  expect(parseCommand({ type: 'mix', track: 2, prop: 'volume', value: 0.5 })).toEqual({ type: 'mix', track: 2, prop: 'volume', value: 0.5 });
  expect(parseCommand({ type: 'mix', track: 2, prop: 'volume', value: 3 })).toBeNull();
  expect(parseCommand({ type: 'mix', track: 2, prop: 'name', value: 1 })).toBeNull();
});

describe('sessionSongs', () => {
  const sc = (index: number, name: string, isEmpty = false): Scene => ({ index, name, color: 0, tempo: null, isEmpty, triggered: false });
  const scenes = [sc(0, 'SONG A'), sc(1, 'Verse'), sc(2, 'Chorus'), sc(3, 'SONG B', true), sc(4, 'Intro'), sc(5, '', true), sc(6, 'Outro')];
  it('groups scenes into songs; a song scene with clips is its first section', () => {
    const songs = sessionSongs(scenes, ['SONG A@0', 'SONG B@3'], none);
    expect(songs.map((s) => [s.name, s.start, s.end])).toEqual([['SONG A', 0, 3], ['SONG B', 3, 5]]);
    expect(songs[0]!.sections.map((s) => [s.name, s.start])).toEqual([['SONG A', 0], ['Verse', 1], ['Chorus', 2]]);
  });
  it('empty scenes are never sections; an empty header starts a song, an empty spacer ends it', () => {
    const songs = sessionSongs(scenes, ['SONG A@0', 'SONG B@3'], none);
    expect(songs[1]!.sections.map((s) => s.start)).toEqual([4]); // Outro (6) is after the spacer
    expect(songs[1]!.end).toBe(5);
  });
  it('a song with no clips launches nothing, and never borrows the MIDI or click scenes after it', () => {
    // a real set: song, (Key), spacer; Sgala kemuliaan has no clips yet; MIDI and click scenes at the end
    const rows: [string, boolean][] = [['Gloria', false], ['(Key)', false], ['', true], ['Malam kudus', false], ['F#', true], ['', true],
      ['Sgala kemuliaan', true], ['(Key)', true], ['', true], ['8 Song', true], ['MIDI CLIPS', false], ['MIDI CLIPS', false], ['Auto-Click 6/8', false]];
    const set = rows.map(([n, empty], i) => sc(i, n, empty));
    const songs = sessionSongs(set, ['Gloria@0', 'Malam kudus@3', 'Sgala kemuliaan@6'], none);
    expect(songs.map((s) => [s.name, s.end, s.sections.map((x) => x.name)])).toEqual([
      ['Gloria', 2, ['Gloria', '(Key)']], ['Malam kudus', 4, ['Malam kudus']], ['Sgala kemuliaan', 7, []]]);
    expect(playable(songs, 'session').map((s) => s.name)).toEqual(['Gloria', 'Malam kudus']);
  });
});

it('quantBeats maps Live launch quantization to beats', () => {
  expect(quantBeats(0, 4, 4)).toBe(0);
  expect(quantBeats(4, 4, 4)).toBe(4); // 1 bar
  expect(quantBeats(1, 4, 4)).toBe(32); // 8 bars
  expect(quantBeats(4, 6, 8)).toBe(3);
  expect(quantBeats(7, 4, 4)).toBe(1); // 1/4
});

describe('cue pads', () => {
  it('MIDI bytes: note on, CC and program change bind; note off and zero values do not', () => {
    expect(parseMidi([0x99, 36, 100])).toEqual({ kind: 'note', channel: 10, number: 36 });
    expect(parseMidi([0x99, 36, 0])).toBeNull(); // note on with velocity 0 = note off
    expect(parseMidi([0x89, 36, 64])).toBeNull();
    expect(parseMidi([0xb0, 20, 127])).toEqual({ kind: 'cc', channel: 1, number: 20 });
    expect(parseMidi([0xb0, 20, 0])).toBeNull();
    expect(parseMidi([0xc2, 5])).toEqual({ kind: 'pc', channel: 3, number: 5 });
    expect(parseMidi([0xf8])).toBeNull(); // clock
  });
  it('pad MIDI and clip jumps are validated', () => {
    expect(parseCommand({ type: 'setPadMidi', pads: [{ kind: 'note', channel: 10, number: 36 }, null] })).not.toBeNull();
    expect(parseCommand({ type: 'setPadMidi', pads: [{ kind: 'note', channel: 17, number: 36 }] })).toBeNull();
    expect(parseCommand({ type: 'clipJump', scene: 0, beat: 32, label: 'Chorus' })).toEqual({ type: 'clipJump', scene: 0, beat: 32, label: 'Chorus', immediate: undefined });
    expect(parseCommand({ type: 'clipJump', scene: 0, beat: -1, label: 'x' })).toBeNull();
  });
});
