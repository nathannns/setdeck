// Song timeline: an imported mixdown waveform, section markers the user places, and the playhead.
// Works in both views. Positions are beats from the song's start. In Session view the playhead is
// the time since the song's first scene launched (Live has no song position for scenes).

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  beatsPerBar, beatsToSeconds, formatBarBeat, formatTime, type Command, type LiveState, type Song, type Timer, type Wave,
} from '@setdeck/shared';
import { HoldButton, sectionColor } from './ui.tsx';

const NAMES = ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Solo', 'Break', 'Outro'];
const PEAKS = 4000; // enough detail to zoom in 32x

/** Decodes an audio file in the browser into peaks (0..99). Only the peaks go to the server. */
async function readPeaks(file: File): Promise<{ peaks: number[]; seconds: number }> {
  const ctx = new AudioContext();
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
    const step = Math.max(1, Math.floor(buf.length / PEAKS));
    const raw = Array.from({ length: Math.min(PEAKS, buf.length) }, (_, i) => {
      let m = 0;
      for (const ch of chans) for (let j = i * step; j < (i + 1) * step; j += 8) m = Math.max(m, Math.abs(ch[j] ?? 0));
      return m;
    });
    const top = Math.max(...raw) || 1;
    return { peaks: raw.map((v) => Math.round((v / top) * 99)), seconds: buf.duration };
  } finally {
    void ctx.close();
  }
}

/** The song's waveform from its clips in Live (Session): each audio stem is decoded here, one at a time,
 *  and their levels are added up, so it shows the whole mix. Timing comes from the clips: a warped stem
 *  plays its file from beat 0 to its end, so end beats over file seconds is the tempo it was made at. */
async function livePeaks(scene: number, tempo: number): Promise<Wave | null> {
  const stems = (await (await fetch(`/api/stems/${scene}`)).json()) as { url: string; start: number; end: number; beats: boolean }[];
  const STEP = 0.01; // seconds per level reading
  const mix: number[] = [];
  let bpm = 0;
  const ctx = new AudioContext();
  try {
    for (const s of stems) {
      const buf = await fetch(s.url).then((r) => r.arrayBuffer()).then((a) => ctx.decodeAudioData(a)).catch(() => null);
      if (!buf) continue;
      // ponytail: assumes a warped clip ends where its file ends (exported stems do); else the timing stretches
      const b = s.beats ? (s.end * 60) / buf.duration : tempo; // unwarped: plays in real time at the song tempo
      bpm ||= b;
      const skip = Math.round((s.beats ? (s.start * 60) / b : s.start) / STEP); // a clip that starts part-way into its file
      const per = Math.round(buf.sampleRate * STEP);
      const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
      for (let k = skip; k * per < buf.length; k++) {
        let m = 0;
        for (const ch of chans) for (let j = k * per, e = Math.min(j + per, buf.length); j < e; j += 4) m = Math.max(m, Math.abs(ch[j]!));
        mix[k - skip] = (mix[k - skip] ?? 0) + m;
      }
    }
  } finally {
    void ctx.close();
  }
  if (!mix.length) return null;
  const n = Math.min(PEAKS, mix.length);
  const raw = Array.from({ length: n }, (_, i) => Math.max(...mix.slice(Math.floor((i * mix.length) / n), Math.floor(((i + 1) * mix.length) / n))));
  const top = Math.max(...raw) || 1;
  return { peaks: raw.map((v) => Math.round((v / top) * 99)), seconds: mix.length * STEP, bpm: Math.round(bpm * 100) / 100, live: true };
}
// Built by the SetDeck window on the Mac, where the files are (a tablet would pull every stem over Wi-Fi).
const LOCAL = typeof location !== 'undefined' && ['localhost', '127.0.0.1'].includes(location.hostname);

type Props = {
  song: Song;
  wave?: Wave;
  /** Beats since the song started, or null when it is not playing (Session) / not the current song. */
  elapsed: number | null;
  live: LiveState;
  session: boolean;
  send: (c: Command) => void;
  /** The panel shows the next song, not the one playing (the top bar names the current one). */
  upcoming?: boolean;
  /** Shown in the header row (the queued-jump notice). */
  children?: ReactNode;
  /** Edit mode and the selected section marker (its beat) are shared with the pads: a pad is a section. */
  editing: boolean;
  setEditing: (on: boolean) => void;
  sel: number | null;
  setSel: (beat: number | null) => void;
  /** Plays the song from a beat into it, at once. */
  playFrom: (beat: number) => void;
};

export function WavePanel({ song, wave, elapsed, live, session, send, upcoming, children, editing, setEditing, sel, setSel, playFrom }: Props) {
  const [cursor, setCursor] = useState(0);
  const [cursorSet, setCursorSet] = useState(false); // tapped a spot: the next name goes there, not at the playhead
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null); // a marker being dragged (beats)
  const lastTap = useRef({ t: 0, x: 0 });
  const inner = useRef<HTMLDivElement>(null);
  const [custom, setCustom] = useState('');
  const [note, setNote] = useState('');
  const [history, setHistory] = useState<Timer[][]>([]); // earlier marker lists, for UNDO
  const [zoom, setZoom] = useState(1); // 1 = whole song in view, up to 32
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null); // the scrolling view
  const anchor = useRef<{ beat: number; x: number } | null>(null); // what stays put while zooming
  const fileInput = useRef<HTMLInputElement>(null);

  // Session: the waveform always comes from the song's clips in Live, never an imported file.
  const scene = session ? song.sections[0]?.start : undefined;
  const building = useRef(false);
  useEffect(() => {
    if (scene === undefined || wave?.live || building.current || !LOCAL) return;
    building.current = true; // once per song shown (the panel remounts per song)
    setNote('Reading the song from Live…');
    const tempo = song.bpm ?? live.scenes[song.start]?.tempo ?? live.tempo;
    livePeaks(scene, tempo)
      .then((w) => { if (w) send({ type: 'setWave', id: song.id, wave: w }); setNote(w ? '' : 'No audio clips in Live for this song.'); return w; })
      .catch(() => { setNote('Can\'t read this song\'s audio from Live.'); return null; })
      .then((w) => { if (!w) setTimeout(() => { building.current = false; }, 5000); }); // try again (Live may still be loading)
  }, [scene, wave?.live, song, live, send]);

  const bar = beatsPerBar(live.sigNum, live.sigDen);
  const timers = song.timers ?? [];
  const waveBeats = wave ? (wave.seconds * wave.bpm) / 60 : 0;
  // Timeline length: the waveform if there is one, else the arrangement song, with room after the last marker.
  const span = Math.max(session ? 0 : song.end - song.start, waveBeats, (timers.at(-1)?.beat ?? 0) + (wave ? 1 : 8) * bar, wave ? 0 : 16 * bar);
  const pct = (b: number) => `${(Math.min(Math.max(b, 0), span) / span) * 100}%`;
  const step = zoom >= 4 ? 1 : bar; // zoomed in: place markers on the beat, else on the bar
  const snap = (b: number) => Math.max(0, Math.round(b / step) * step);
  const where = (b: number) => `bar ${formatBarBeat(b, live.sigNum, live.sigDen)}`;
  const capturing = live.playing && elapsed !== null;

  const cur = elapsed === null ? -1 : timers.reduce((k, t, i) => (t.beat <= elapsed + 1e-6 ? i : k), -1);
  const next = cur >= 0 ? timers[cur + 1] : undefined;
  const leftBeats = elapsed === null || cur < 0 ? null : next ? next.beat - elapsed : wave ? waveBeats - elapsed : null;

  // The canvas covers only the visible part of the (zoomed) timeline and is redrawn as it scrolls.
  useEffect(() => {
    const c = canvas.current;
    const sc = box.current;
    if (!c || !sc) return;
    let raf = 0;
    const draw = () => {
      raf = 0;
      const w = c.clientWidth;
      const h = c.clientHeight;
      const dpr = devicePixelRatio || 1;
      c.width = w * dpr;
      c.height = h * dpr;
      const g = c.getContext('2d');
      if (!g || !wave || !sc.scrollWidth || !waveBeats) return;
      g.scale(dpr, dpr);
      g.fillStyle = getComputedStyle(c).color;
      const n = wave.peaks.length;
      const b0 = (sc.scrollLeft / sc.scrollWidth) * span;
      const bpp = ((sc.clientWidth / sc.scrollWidth) * span) / w; // beats per pixel
      for (let x = 0; x < w; x++) {
        const b = b0 + x * bpp;
        if (b >= waveBeats) break;
        const i0 = Math.floor((b / waveBeats) * n);
        const i1 = Math.max(i0 + 1, Math.floor(((b + bpp) / waveBeats) * n));
        let p = 0;
        for (let i = i0; i < i1 && i < n; i++) p = Math.max(p, wave.peaks[i]!); // loudest peak under this pixel
        const ph = Math.max(1, (p / 99) * h * 0.86);
        g.fillRect(x, (h - ph) / 2, 1, ph);
      }
    };
    const later = () => { if (!raf) raf = requestAnimationFrame(draw); };
    draw();
    const ro = new ResizeObserver(later);
    ro.observe(c);
    sc.addEventListener('scroll', later, { passive: true });
    return () => { ro.disconnect(); sc.removeEventListener('scroll', later); cancelAnimationFrame(raf); };
  }, [wave, waveBeats, span, zoom]);

  // Zoom keeps one point where it is: the pinch point, else the playhead, selected marker or cursor if in view.
  const zoomBy = (f: number, clientX?: number) => {
    const sc = box.current;
    if (!sc) return;
    const z = Math.min(32, Math.max(1, zoom * f));
    const xOf = (b: number) => (b / span) * sc.scrollWidth - sc.scrollLeft;
    const focus = [elapsed, sel, editing ? cursor : null].find((b): b is number => b !== null && xOf(b) >= 0 && xOf(b) <= sc.clientWidth);
    const x = clientX !== undefined ? clientX - sc.getBoundingClientRect().left : focus !== undefined ? xOf(focus) : sc.clientWidth / 2;
    anchor.current = { beat: ((sc.scrollLeft + x) / sc.scrollWidth) * span, x };
    setZoom(z);
  };
  useLayoutEffect(() => {
    const sc = box.current;
    const a = anchor.current;
    if (!sc || !a) return;
    anchor.current = null;
    sc.scrollLeft = (a.beat / span) * sc.scrollWidth - a.x;
  }, [zoom, span]);
  // Trackpad pinch (ctrl + wheel) zooms the waveform, not the page.
  const zoomFn = useRef(zoomBy);
  useEffect(() => { zoomFn.current = zoomBy; });
  useEffect(() => {
    const sc = box.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => { if (!e.ctrlKey) return; e.preventDefault(); zoomFn.current(Math.exp(-e.deltaY / 100), e.clientX); };
    sc.addEventListener('wheel', onWheel, { passive: false });
    return () => sc.removeEventListener('wheel', onWheel);
  }, []);
  // Zoomed in while playing: keep the playhead in view.
  useEffect(() => {
    const sc = box.current;
    if (!sc || zoom === 1 || elapsed === null || !live.playing) return;
    const x = (elapsed / span) * sc.scrollWidth;
    if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth * 0.85) sc.scrollLeft = x - sc.clientWidth * 0.25;
  }, [elapsed, zoom, span, live.playing]);

  const save = (t: Timer[]) => {
    setHistory((h) => [...h.slice(-29), timers]);
    send({ type: 'setTimers', id: song.id, timers: t });
  };
  const undo = () => {
    const prev = history.at(-1);
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setSel(null);
    send({ type: 'setTimers', id: song.id, timers: prev });
  };
  const place = (name: string) => {
    if (sel !== null) return save(timers.map((t) => (t.beat === sel ? { ...t, name } : t)));
    const beat = capturing && !cursorSet ? snap(elapsed) : cursor;
    save([...timers.filter((t) => t.beat !== beat), { name, beat }]);
    setCursorSet(false);
  };
  const beatAt = (clientX: number) => {
    const r = inner.current!.getBoundingClientRect();
    return snap(((clientX - r.left) / r.width) * span);
  };
  // Dragging a marker moves it (snapped like placing); a press without moving selects it.
  const dragTo = (to: number) => setDrag((d) => d && { ...d, to: timers.some((t) => t.beat === to && t.beat !== d.from) ? d.to : to });
  const dragEnd = () => {
    if (!drag) return;
    setDrag(null);
    if (drag.to === drag.from) return setSel(drag.from === sel ? null : drag.from);
    save(timers.map((t) => (t.beat === drag.from ? { ...t, beat: drag.to } : t)));
    setSel(drag.to);
  };
  const nudge = (d: number) => {
    if (sel === null) return setCursor((c) => Math.max(0, c + d));
    const b = Math.max(0, sel + d);
    if (timers.some((t) => t.beat === b)) return;
    save(timers.map((t) => (t.beat === sel ? { ...t, beat: b } : t)));
    setSel(b);
  };
  const importFile = async (f: File) => {
    setNote('Reading…');
    try {
      const { peaks, seconds } = await readPeaks(f);
      const bpm = song.bpm ?? (session ? live.scenes[song.start]?.tempo : null) ?? live.tempo;
      send({ type: 'setWave', id: song.id, wave: { peaks, seconds, bpm: Math.round(bpm * 100) / 100 } });
      setNote('');
    } catch {
      setNote('Can\'t read that file. Use a WAV or AIFF.');
    }
  };

  return (
    <section
      className="panel wave-panel"
      aria-label="Song timeline"
      onDragOver={session ? undefined : (e) => e.preventDefault()}
      onDrop={session ? undefined : (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void importFile(f); }}
    >
      <div className="wave-top">
        <div className="wave-now" aria-live="polite">
          {cur >= 0 ? (
            <>
              <b style={{ color: sectionColor(timers[cur]!.name, cur) }}>{timers[cur]!.name}</b>
              {leftBeats !== null && <span> {formatTime(beatsToSeconds(leftBeats, live.tempo))} {next ? `to ${next.name}` : 'to the end'}</span>}
            </>
          ) : (
            upcoming && <span className="label">Next · {song.name}</span>
          )}
        </div>
        {children}
        <div className="wave-row">
          <div className="zoom" role="group" aria-label="Zoom">
            <button className="icon-btn" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => zoomBy(0.5)}>−</button>
            <button className="icon-btn" aria-label="Reset zoom" title="Pinch on the waveform to zoom" onClick={() => zoomBy(1 / zoom)}>{zoom < 10 ? Number(zoom.toFixed(1)) : Math.round(zoom)}×</button>
            <button className="icon-btn" aria-label="Zoom in" disabled={zoom >= 32} onClick={() => zoomBy(2)}>+</button>
          </div>
          {history.length > 0 && <button className="icon-btn" onClick={undo} aria-label="Undo last section change">UNDO</button>}
          <button className="icon-btn" aria-pressed={editing} onClick={() => { setEditing(!editing); setSel(null); }}>
            {editing ? 'DONE' : 'EDIT'}
          </button>
        </div>
      </div>

      <div className={`wave-box${editing ? ' editing' : ''}`}>
        <canvas ref={canvas} aria-hidden />
        {!wave && (
          <div className="wave-empty">{session ? note || 'No waveform' : editing ? 'Drop a WAV here, or IMPORT WAV' : 'No waveform'}</div>
        )}
        <div className="wave" ref={box}>
      <div
        className="wave-inner"
        ref={inner}
        style={{ width: `${zoom * 100}%` }}
        onPointerDown={editing ? (e) => {
          const b = beatAt(e.clientX);
          const now = e.timeStamp;
          const again = now - lastTap.current.t < 400 && Math.abs(e.clientX - lastTap.current.x) < 24;
          lastTap.current = { t: again ? 0 : now, x: e.clientX };
          setCursor(b);
          setSel(null);
          setCursorSet(!again); // double-tap: play from there (the next name then goes at the playhead again)
          if (again) playFrom(b);
        } : undefined}
      >
        {timers.map((t, i) => (
          <div key={t.beat} className="wave-band" aria-hidden
            style={{ left: pct(t.beat), width: pct((timers[i + 1]?.beat ?? span) - t.beat), '--c': sectionColor(t.name, i) } as CSSProperties} />
        ))}
        {elapsed !== null && <div className="wave-played" style={{ width: pct(elapsed) }} />}
        {timers.map((t, i) => {
          const style = { left: pct(t.beat), '--c': sectionColor(t.name, i) } as CSSProperties;
          return editing ? (
            <button key={t.beat} className={`wmark${t.beat === sel ? ' sel' : ''}${drag?.from === t.beat ? ' dragging' : ''}`}
              style={drag?.from === t.beat ? { ...style, left: pct(drag.to) } : style} aria-pressed={t.beat === sel}
              aria-label={`${t.name} at ${where(t.beat)}`}
              onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setDrag({ from: t.beat, to: t.beat }); }}
              onPointerMove={(e) => { if (drag?.from === t.beat) dragTo(beatAt(e.clientX)); }}
              onPointerUp={dragEnd} onPointerCancel={() => setDrag(null)}
              onClick={(e) => { if (e.detail === 0) setSel(t.beat === sel ? null : t.beat); }}>{t.name}</button>
          ) : (
            <span key={t.beat} className={`wmark${i === cur ? ' on' : ''}`} style={style}>{t.name}</span>
          );
        })}
        {editing && (!capturing || cursorSet) && sel === null && <div className="wave-cursor" style={{ left: pct(cursor) }} aria-hidden />}
        {elapsed !== null && <div className="wave-playhead" style={{ left: pct(elapsed) }} aria-hidden />}
      </div>
        </div>
      </div>

      {editing && (
        <div className="wave-edit">
          <p className="wave-hint" aria-live="polite">
            {note || (sel !== null
              ? `${timers.find((t) => t.beat === sel)?.name}, ${where(sel)}: rename, nudge, drag or delete.`
              : capturing && !cursorSet
                ? 'Tap a name at the playhead, or tap the wave first. Double-tap plays from there.'
                : `${where(cursor)}: tap a name to mark it here. Double-tap plays from there. Drag a name to move it.`)}
          </p>
          <div className="wave-row">
            {NAMES.map((n, i) => (
              <button key={n} className="chipbtn" style={{ '--c': sectionColor(n, i) } as CSSProperties} onClick={() => place(n)}>{n}</button>
            ))}
            <form className="wave-row" onSubmit={(e) => { e.preventDefault(); const v = custom.trim(); if (v) { place(v.slice(0, 40)); setCustom(''); } }}>
              <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Other name" aria-label="Other section name" maxLength={40} />
              <button className="chipbtn" disabled={!custom.trim()}>ADD</button>
            </form>
          </div>
          <div className="wave-row">
            <button className="chipbtn tool" aria-label="Back one bar" onClick={() => nudge(-bar)}>−BAR</button>
            <button className="chipbtn tool" aria-label="Back one beat" onClick={() => nudge(-1)}>−BEAT</button>
            <button className="chipbtn tool" aria-label="Forward one beat" onClick={() => nudge(1)}>+BEAT</button>
            <button className="chipbtn tool" aria-label="Forward one bar" onClick={() => nudge(bar)}>+BAR</button>
            <button className="chipbtn danger" disabled={sel === null} title="Tap a marker on the waveform first"
              onClick={() => { save(timers.filter((t) => t.beat !== sel)); setSel(null); }}>DELETE</button>
            {timers.length > 0 && (
              <HoldButton className="chipbtn danger" aria-label="Delete all sections (hold)" onTap={() => setNote('Hold to clear. UNDO restores.')}
                onHold={() => { save([]); setSel(null); setNote(''); }}>CLEAR ALL</HoldButton>
            )}
            <span className="spacer" />
            {!session && wave && (
              <label className="wave-bpm" title="The tempo the song was exported at. Change it if the waveform does not line up.">
                MIX BPM
                <input type="number" step={0.01} min={20} max={999} defaultValue={wave.bpm}
                  onChange={(e) => { const b = Number(e.target.value); if (b >= 20 && b <= 999) send({ type: 'setWave', id: song.id, wave: { ...wave, bpm: b } }); }} />
              </label>
            )}
            {!session && <button className="icon-btn" onClick={() => fileInput.current?.click()}>{wave ? 'REPLACE WAV' : 'IMPORT WAV'}</button>}
            {!session && wave && (
              <HoldButton className="icon-btn" aria-label="Remove waveform (hold)" onTap={() => setNote('Hold to remove.')}
                onHold={() => { send({ type: 'setWave', id: song.id, wave: null }); setNote(''); }}>REMOVE WAV</HoldButton>
            )}
            <input ref={fileInput} type="file" accept="audio/*,.wav,.aif,.aiff" hidden
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
          </div>
        </div>
      )}
    </section>
  );
}
