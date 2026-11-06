// Types, WebSocket message schemas and pure setlist/time helpers shared by server and web.
// Two views of a Live set:
//   arrangement: songs/sections come from locators; positions are beats (quarter notes).
//   session:     songs/sections come from scenes; positions are scene indices.
// Time is for display only.

export type Connection = 'starting' | 'connected' | 'no-reply' | 'port-busy';
export type View = 'session' | 'arrangement';

export type Cue = { index: number; name: string; time: number };
/** isGroup: a group track. parent: index of the group track it sits in (Live's group_track), -1 at the top level. */
export type Track = {
  index: number; name: string; mute: boolean; solo: boolean; volume: number; color: number; playingSlot: number;
  isGroup: boolean; parent: number;
};
/** tempo is null unless the scene has its own tempo enabled. */
export type Scene = { index: number; name: string; color: number; tempo: number | null; isEmpty: boolean; triggered: boolean };

export type LiveState = {
  playing: boolean;
  position: number;
  tempo: number;
  sigNum: number;
  sigDen: number;
  loop: boolean;
  metronome: boolean;
  songLength: number;
  launchQuant: number; // clip_trigger_quantization enum
  cues: Cue[];
  scenes: Scene[];
  tracks: Track[];
};

/** start/end: beats (arrangement) or scene indices (session). end is exclusive. */
export type Section = { name: string; start: number };
/** A section marker the user places on the song's timeline. beat: from the song's start. */
export type Timer = { name: string; beat: number };
export type SongData = { key?: string; bpm?: number; timers?: Timer[] };
/** Picture of an imported mixdown: peaks 0..99, mapped to beats with the tempo it was exported at.
 *  Sent apart from AppState (it is big and rarely changes). */
/** live: built from the song's clips in Live (Session view), not an imported file. */
export type Wave = { peaks: number[]; seconds: number; bpm: number; live?: boolean };
export type MixProp = 'volume' | 'mute' | 'solo';
/** A MIDI message that presses a pad. channel 1-16, number 0-127 (note, CC or program number).
 *  Pads are the current song's sections in order; padMidi[i] presses pad i in every song. */
export type MidiBinding = { kind: 'note' | 'cc' | 'pc'; channel: number; number: number };
export type Song = SongData & { id: string; name: string; start: number; end: number; hidden: boolean; sections: Section[] };
/** target: beat or scene index; atBeat: transport beat when it should land (estimate in session). */
export type Pending = { label: string; target: number; atBeat: number };

export type AppState = {
  connection: Connection;
  view: View;
  live: LiveState;
  setupDone: boolean;
  marks: string[];
  songs: Song[]; // setlist order, hidden ones included (flagged)
  pending: Pending | null;
  /** Where the performer is: playhead beat (arrangement) or playing/last launched scene (session, -1 none). */
  at: number;
  /** Transport beat when the current song started (session elapsed time). */
  songStartBeat: number | null;
  padMidi: (MidiBinding | null)[];
};

export type ServerMsg =
  | { type: 'state'; state: AppState }
  | { type: 'pos'; position: number; playing: boolean }
  | { type: 'waves'; waves: Record<string, Wave> };

export type Command =
  | { type: 'play' }
  | { type: 'stop' }
  | { type: 'next'; immediate?: boolean }
  | { type: 'prev'; immediate?: boolean }
  | { type: 'cancel' }
  | { type: 'goto'; beat: number; label: string; immediate?: boolean }
  | { type: 'fire'; scene: number; immediate?: boolean }
  | { type: 'setView'; view: View }
  | { type: 'setTempo'; bpm: number }
  | { type: 'setup'; cueKeys: string[] }
  | { type: 'reorder'; ids: string[] }
  | { type: 'hide'; id: string; hidden: boolean }
  | { type: 'setWave'; id: string; wave: Wave | null }
  | { type: 'setTimers'; id: string; timers: Timer[] }
  | { type: 'mix'; track: number; prop: MixProp; value: number }
  | { type: 'setPadMidi'; pads: (MidiBinding | null)[] }
  /** Session: play the song from `beat` (from its start) by relaunching the clips of `scene` from there. */
  | { type: 'clipJump'; scene: number; beat: number; label: string; immediate?: boolean };

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optBool = (v: unknown) => v === undefined || typeof v === 'boolean';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isWave = (w: unknown): w is Wave => isObj(w) && Array.isArray(w.peaks) && w.peaks.length <= 4000
  && w.peaks.every((p) => isNum(p) && p >= 0 && p <= 99) && isNum(w.seconds) && w.seconds > 0 && w.seconds <= 7200
  && isNum(w.bpm) && w.bpm >= 20 && w.bpm <= 999;
const isMidi = (m: unknown): m is MidiBinding => isObj(m) && (m.kind === 'note' || m.kind === 'cc' || m.kind === 'pc')
  && Number.isInteger(m.channel) && (m.channel as number) >= 1 && (m.channel as number) <= 16
  && Number.isInteger(m.number) && (m.number as number) >= 0 && (m.number as number) <= 127;
const isPadMidi = (p: unknown): p is (MidiBinding | null)[] => Array.isArray(p) && p.length <= 64 && p.every((x) => x === null || isMidi(x));
const isTimers = (t: unknown): t is Timer[] => Array.isArray(t) && t.length <= 64
  && t.every((x) => isObj(x) && typeof x.name === 'string' && x.name.length <= 40 && isNum(x.beat) && x.beat >= 0);

/** Runtime validation of client commands. Returns null for anything malformed. */
export function parseCommand(raw: unknown): Command | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  switch (c.type) {
    case 'play': case 'stop': case 'cancel': return { type: c.type };
    case 'next': case 'prev': return optBool(c.immediate) ? { type: c.type, immediate: c.immediate as boolean | undefined } : null;
    case 'goto': return isNum(c.beat) && c.beat >= 0 && typeof c.label === 'string' && optBool(c.immediate)
      ? { type: 'goto', beat: c.beat, label: c.label, immediate: c.immediate as boolean | undefined } : null;
    case 'fire': return Number.isInteger(c.scene) && (c.scene as number) >= 0 && optBool(c.immediate)
      ? { type: 'fire', scene: c.scene as number, immediate: c.immediate as boolean | undefined } : null;
    case 'setView': return c.view === 'session' || c.view === 'arrangement' ? { type: 'setView', view: c.view } : null;
    case 'setTempo': return isNum(c.bpm) && c.bpm >= 20 && c.bpm <= 999 ? { type: 'setTempo', bpm: c.bpm } : null;
    case 'setup': return isStrArr(c.cueKeys) ? { type: 'setup', cueKeys: c.cueKeys } : null;
    case 'reorder': return isStrArr(c.ids) ? { type: 'reorder', ids: c.ids } : null;
    case 'hide': return typeof c.id === 'string' && typeof c.hidden === 'boolean' ? { type: 'hide', id: c.id, hidden: c.hidden } : null;
    case 'setWave': return typeof c.id === 'string' && (c.wave === null || isWave(c.wave))
      ? { type: 'setWave', id: c.id, wave: c.wave === null ? null : { peaks: c.wave.peaks, seconds: c.wave.seconds, bpm: c.wave.bpm, ...(c.wave.live === true && { live: true }) } } : null;
    case 'setTimers': return typeof c.id === 'string' && isTimers(c.timers)
      ? { type: 'setTimers', id: c.id, timers: c.timers.map((t) => ({ name: t.name, beat: t.beat })).sort((a, b) => a.beat - b.beat) } : null;
    case 'setPadMidi': return isPadMidi(c.pads)
      ? { type: 'setPadMidi', pads: c.pads.map((m) => (m ? { kind: m.kind, channel: m.channel, number: m.number } : null)) } : null;
    case 'clipJump': return Number.isInteger(c.scene) && (c.scene as number) >= 0 && isNum(c.beat) && c.beat >= 0 && typeof c.label === 'string' && optBool(c.immediate)
      ? { type: 'clipJump', scene: c.scene as number, beat: c.beat, label: c.label.slice(0, 80), immediate: c.immediate as boolean | undefined } : null;
    case 'mix': return Number.isInteger(c.track) && (c.track as number) >= 0
      && (c.prop === 'volume' || c.prop === 'mute' || c.prop === 'solo') && isNum(c.value) && c.value >= 0 && c.value <= 1
      ? { type: 'mix', track: c.track as number, prop: c.prop, value: c.value } : null;
    default: return null;
  }
}

// ---------- setlist derivation ----------

export const cueKey = (c: { name: string; time: number }) => `${c.name}@${c.time}`;
const markName = (m: string) => m.slice(0, m.lastIndexOf('@'));

/** Which cue each saved song mark points at: exact name+position first, then same name (locator moved). */
export function resolveMarks(cues: Cue[], marks: string[]): Map<number, string> {
  const out = new Map<number, string>();
  const left: string[] = [];
  for (const m of marks) {
    const c = cues.find((c) => !out.has(c.index) && cueKey(c) === m);
    if (c) out.set(c.index, m); else left.push(m);
  }
  for (const m of left) {
    const c = cues.find((c) => !out.has(c.index) && c.name === markName(m));
    if (c) out.set(c.index, m);
  }
  return out;
}

/** New marks after setup: cues that were already songs keep their old mark (so per-song data survives). */
export function marksFromSetup(cues: Cue[], oldMarks: string[], chosenCueKeys: string[]): string[] {
  const old = resolveMarks(cues, oldMarks);
  return cues.filter((c) => chosenCueKeys.includes(cueKey(c))).map((c) => old.get(c.index) ?? cueKey(c));
}

export type Saved = { order: string[]; hidden: string[]; songData: Record<string, SongData> };

/** Songs from markers (locators, or scenes as {index, name, time: index}): marked ones start songs,
 *  the rest become sections of the song before them. `end` is where the last song ends. */
export function deriveSongs(cues: Cue[], marks: string[], end: number, saved: Saved): Song[] {
  const markOf = resolveMarks(cues, marks);
  const songs: Song[] = [];
  for (const c of [...cues].sort((a, b) => a.time - b.time)) {
    const id = markOf.get(c.index);
    if (id) songs.push({ ...saved.songData[id], id, name: c.name, start: c.time, end: 0, hidden: saved.hidden.includes(id), sections: [] });
    else songs.at(-1)?.sections.push({ name: c.name, start: c.time });
  }
  songs.forEach((s, i) => {
    const last = s.sections.at(-1)?.start ?? s.start;
    s.end = songs[i + 1]?.start ?? Math.max(end, last + 1);
    if (!s.sections.length || s.sections[0]!.start > s.start) s.sections.unshift({ name: 'Start', start: s.start });
  });
  const rank = (id: string, t: number) => { const i = saved.order.indexOf(id); return i === -1 ? saved.order.length + t : i; };
  return songs.map((s, t) => ({ s, r: rank(s.id, t) })).sort((a, b) => a.r - b.r).map((x) => x.s);
}

/** Session songs: the song's own scene (its head) is its first section, named after the scene, then
 *  the scenes with clips right after it. Launching an empty scene stops every clip, so empty scenes are
 *  never sections and the first empty scene after the head ends the song: scenes after it that are not
 *  marked as songs (MIDI clips, click, placeholders) belong to no song. The head itself may be empty (a
 *  header scene). A song whose scenes have no clips in Live gets no sections: nothing to launch. */
export function sessionSongs(scenes: Scene[], marks: string[], saved: Saved): Song[] {
  const songs = deriveSongs(scenes.map((s) => ({ index: s.index, name: s.name, time: s.index })), marks, scenes.length, saved);
  for (const song of songs) {
    const head = song.sections[0];
    if (head?.name === 'Start' && head.start === song.start) head.name = song.name;
    for (let j = song.start + 1; j < song.end; j++) if (scenes[j]?.isEmpty) { song.end = j; break; }
    song.sections = song.sections.filter((x) => x.start < song.end && !scenes[x.start]?.isEmpty);
  }
  return songs;
}

export const songAt = (songs: Song[], at: number) => songs.find((s) => at >= s.start && at < s.end);

export function sectionAt(song: Song, at: number): number {
  let i = 0;
  song.sections.forEach((s, j) => { if (s.start <= at) i = j; });
  return i;
}

/** Songs that can be launched: Session songs need at least one scene with clips. */
export const playable = (songs: Song[], view: View) => (view === 'session' ? songs.filter((s) => s.sections.length > 0) : songs);

/** Next/previous visible song in setlist order, relative to the song at `at`. */
export function neighbour(songs: Song[], at: number, dir: 1 | -1): Song | undefined {
  const visible = songs.filter((s) => !s.hidden);
  const cur = songAt(visible, at);
  if (!cur) return dir === 1 ? visible.find((s) => s.start > at) ?? visible[0] : visible.at(-1);
  return visible[visible.indexOf(cur) + dir];
}

/** Beats per launch-quantization step (clip_trigger_quantization enum). 0 = launch at once. */
export function quantBeats(q: number, num: number, den: number): number {
  const bar = beatsPerBar(num, den);
  return [0, 8 * bar, 4 * bar, 2 * bar, bar, 2, 4 / 3, 1, 2 / 3, 0.5, 1 / 3, 0.25, 1 / 6, 0.125][q] ?? bar;
}

// ---------- cue pads ----------

/** A pad binding from raw MIDI bytes: note on (velocity > 0), CC (value > 0) or program change. */
export function parseMidi(data: ArrayLike<number>): MidiBinding | null {
  const status = data[0] ?? 0;
  const channel = (status & 0x0f) + 1;
  const number = data[1] ?? -1;
  if (number < 0) return null;
  switch (status & 0xf0) {
    case 0x90: return (data[2] ?? 0) > 0 ? { kind: 'note', channel, number } : null;
    case 0xb0: return (data[2] ?? 0) > 0 ? { kind: 'cc', channel, number } : null;
    case 0xc0: return { kind: 'pc', channel, number };
    default: return null;
  }
}
export const sameMidi = (a?: MidiBinding, b?: MidiBinding) => !!a && !!b && a.kind === b.kind && a.channel === b.channel && a.number === b.number;
export const midiText = (m: MidiBinding) => `${m.kind === 'note' ? 'N' : m.kind === 'cc' ? 'CC' : 'PC'}${m.number}${m.channel !== 1 ? ` ch${m.channel}` : ''}`;

// ---------- time ----------

export const beatsPerBar = (num: number, den: number) => (num * 4) / den;
export const nextBar = (beat: number, num: number, den: number) => {
  const bpb = beatsPerBar(num, den);
  return (Math.floor(beat / bpb + 1e-9) + 1) * bpb;
};
export const beatsToSeconds = (beats: number, bpm: number) => (beats * 60) / bpm;

export function formatBarBeat(beat: number, num: number, den: number): string {
  const bpb = beatsPerBar(num, den);
  const bar = Math.floor(beat / bpb + 1e-9);
  const inBar = Math.floor((beat - bar * bpb) / (4 / den) + 1e-9);
  return `${bar + 1}.${inBar + 1}`;
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Arrangement only: session songs have no fixed length. */
export const songSeconds = (s: Song, liveTempo: number) => beatsToSeconds(s.end - s.start, s.bpm ?? liveTempo);
