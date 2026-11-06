import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import {
  beatsToSeconds, formatBarBeat, formatTime, neighbour, playable, sectionAt, songAt, songSeconds,
  type AppState, type Command, type Song, type Wave,
} from '@setdeck/shared';
import { useServer } from './useServer.ts';
import { Setup } from './Setup.tsx';
import { WavePanel } from './Wave.tsx';
import { Mixer } from './Mixer.tsx';
import { Pads } from './Pads.tsx';
import { HoldButton, connectionText } from './ui.tsx';


export default function App() {
  const { state, waves, online, send } = useServer();
  const [setupOpen, setSetupOpen] = useState(false);

  if (!state) {
    const c = connectionText(online, undefined);
    return <div className="empty" style={{ height: '100dvh', justifyContent: 'center' }}><h2>SetDeck</h2><p>{online ? 'Loading…' : c.help}</p></div>;
  }
  if (!state.setupDone || setupOpen) return <Setup key={state.view} state={state} online={online} send={send} onClose={() => setSetupOpen(false)} />;
  return <Perform state={state} waves={waves} online={online} send={send} onSetup={() => setSetupOpen(true)} />;
}

type PerformProps = { state: AppState; waves: Record<string, Wave>; online: boolean; send: (c: Command) => void; onSetup: () => void };

function Perform({ state, waves, online, send, onSetup }: PerformProps) {
  const [drawer, setDrawer] = useState(false);
  const [editing, setEditing] = useState(false); // setlist order
  const [editSections, setEditSections] = useState(false); // sections and pads (waveform EDIT)
  const [sel, setSel] = useState<number | null>(null); // selected section marker, by beat
  const [livePad, setLivePad] = useState<number | null>(null); // selected pad when sections come from Live
  const { live, songs, pending, songStartBeat } = state;
  const { position: pos, tempo, sigNum, sigDen, playing } = live;
  const session = state.view === 'session';

  // Space = play/stop, like Live. Caught before the focused button sees it (no double action);
  // ignored while typing a name. Reads the play state as of the last render (set before paint).
  const isPlaying = useRef(playing);
  useLayoutEffect(() => { isPlaying.current = playing; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.isContentEditable || t.tagName === 'TEXTAREA' || (t instanceof HTMLInputElement && !['range', 'checkbox', 'button', 'file'].includes(t.type));
      if (e.code !== 'Space' || typing || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'keydown' && !e.repeat) send({ type: isPlaying.current ? 'stop' : 'play' });
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKey, true); };
  }, [send]);
  // Arrangement follows the playhead (smooth 'pos' updates); session follows the playing scene.
  const at = session ? state.at : pos;

  const visible = songs.filter((s) => !s.hidden);
  const current = songAt(songs, at);
  const next = neighbour(playable(songs, state.view), at, 1);
  const secIdx = current ? sectionAt(current, at) : -1;
  const bar = (b: number) => formatBarBeat(b, sigNum, sigDen).split('.')[0];
  const length = (s: Song) => (!session ? formatTime(songSeconds(s, tempo)) : s.sections.length ? `${s.sections.length} scenes` : 'NO CLIPS');
  const conn = connectionText(online, state.connection);
  const total = session ? 0 : visible.reduce((t, s) => t + songSeconds(s, tempo), 0);

  // Session: a section is a scene, so launching it is a scene fire (Live's launch quantization queues it).
  const gotoSection = (song: Song, i: number, immediate = false) => {
    const sec = song.sections[i];
    if (!sec) return;
    if (session) send({ type: 'fire', scene: sec.start, immediate });
    else send({ type: 'goto', beat: sec.start, label: `${song.name} · ${sec.name}`, immediate });
  };
  const gotoSong = (s: Song, immediate = false) => {
    if (session) gotoSection(s, 0, immediate);
    else send({ type: 'goto', beat: s.start, label: s.name, immediate });
    setDrawer(false);
  };
  const move = (id: string, d: -1 | 1) => {
    const ids = songs.map((s) => s.id);
    const i = ids.indexOf(id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    send({ type: 'reorder', ids });
  };

  // Beats into the current song. Session: since its first scene launched (null when stopped).
  // ponytail: assumes the song's scenes play in order; jumping to a later scene doesn't move this.
  const songBeats = !current ? null
    : session ? (playing && songStartBeat !== null ? pos - songStartBeat : null)
    : pos - current.start;
  const elapsed = songBeats === null ? 0 : beatsToSeconds(songBeats, tempo);
  const shown = current ?? next;

  // The song's sections, once, as the pads: markers placed on the waveform, else Live's own (scenes in
  // Session, locators in Arrangement). Marker pads jump inside the song: Session relaunches its clips
  // from there (clipJump), Arrangement moves the playhead.
  const timers = shown?.timers ?? [];
  const markerPads = timers.length > 0;
  const curMarker = shown && shown === current && songBeats !== null ? timers.reduce((k, t, i) => (t.beat <= songBeats + 1e-6 ? i : k), -1) : -1;
  const sectionPads = !shown ? [] : markerPads
    ? timers.map((t, i) => ({ name: t.name, on: i === curMarker, queued: !session && pending?.target === shown.start + t.beat }))
    : shown.sections.map((s, i) => ({ name: s.name, on: shown === current && i === secIdx, queued: pending?.target === s.start }));
  // Always at least 8 pads, like a pad controller: the spare ones are blank until a section lands there
  // (a hardware pad can be learned for them already).
  const padItems = Array.from({ length: Math.max(8, sectionPads.length) }, (_, i) => sectionPads[i] ?? { name: '', on: false, queued: false });
  // Pads act at once (a drum pad must not wait for the bar); NEXT/PREV still queue.
  const pressPad = (i: number) => {
    if (!shown) return;
    const t = timers[i];
    if (!markerPads) gotoSection(shown, i, true);
    else if (!t) return;
    else if (!session) send({ type: 'goto', beat: shown.start + t.beat, label: `${shown.name} · ${t.name}`, immediate: true });
    else playFrom(t.beat, t.name);
  };
  // Play the shown song from a beat into it, at once (pads, and double-tap on the waveform).
  const playFrom = (beat: number, label = 'here') => {
    if (!shown) return;
    if (!session) send({ type: 'goto', beat: shown.start + beat, label: `${shown.name} · ${label}`, immediate: true });
    else if (shown.sections[0]) send({ type: 'clipJump', scene: shown.sections[0].start, beat, label, immediate: true });
  };
  const padSel = markerPads && sel !== null ? timers.findIndex((t) => t.beat === sel) : livePad;
  const selectPad = (i: number) => {
    const t = markerPads ? timers[i] : undefined;
    setSel(t ? t.beat : null); // a marker pad selects its marker on the waveform too
    setLivePad(t ? null : i);
  };
  const remaining = current && !session ? beatsToSeconds(current.end - pos, tempo) : 0;
  const pendingIn = pending ? Math.max(0, pending.atBeat - pos) : 0;

  const queueBox = pending && (
    <div className="queue" aria-live="polite">
      <span className="qtarget">→ {pending.label}</span>
      <span className="qwhen">bar {bar(pending.atBeat)} · {pendingIn.toFixed(1)} beats</span>
      {/* Session: Live owns the triggered scene; launching another one replaces it. */}
      {!session && <button className="cancel" onClick={() => send({ type: 'cancel' })}>CANCEL</button>}
    </div>
  );

  return (
    <div className="app">
      <header className="topbar">
        <button className="icon-btn menu-btn" aria-label="Open setlist" onClick={() => setDrawer(true)}>☰</button>
        <div className="preset-name" aria-live="polite">{current?.name ?? (playing ? 'Not in a song' : 'Stopped')}</div>
        <div className="readouts" role="group" aria-label="Song">
          {current?.key && <Readout label="Key" value={current.key} />}
          <Readout label="BPM" value={tempo.toFixed(tempo % 1 ? 2 : 0)} />
          <Readout label="Bar" value={formatBarBeat(pos, sigNum, sigDen)} />
          <Readout label="Elapsed" value={formatTime(elapsed)} keep />
          {!session && <Readout label="Left" value={`-${formatTime(remaining)}`} />}
          {live.loop && <span className="tag">LOOP</span>}
          {live.metronome && <span className="tag">CLICK</span>}
        </div>
        <div className={`conn ${conn.ok ? 'ok' : 'bad'}`} title={conn.help} role="status">
          <span className="dot" aria-hidden /> <span className="conn-text">{conn.short}</span>
        </div>
        <button className="icon-btn" onClick={onSetup} aria-label={`Set up setlist from ${session ? 'scenes' : 'locators'}`}>SETUP</button>
      </header>

      <div className={`scrim${drawer ? ' open' : ''}`} onClick={() => setDrawer(false)} />
      <aside className={`sidebar${drawer ? ' open' : ''}`} aria-label="Setlist">
        <div className="side-head">
          <span className="label">
            {visible.length} songs{!session && <> · <span className="total" aria-label="Total set duration">{formatTime(total)}</span></>}
          </span>
          <button className="icon-btn" aria-pressed={editing} onClick={() => setEditing(!editing)}>{editing ? 'DONE' : 'EDIT'}</button>
        </div>
        <div className="songlist">
          {(editing ? songs : visible).map((s, i) => (
            <div key={s.id} className="song-row">
              <HoldButton
                className={`song-btn${s === current ? ' current' : ''}${s === next ? ' next' : ''}${pending?.target === s.start ? ' queued' : ''}${s.hidden || (session && !s.sections.length) ? ' hidden-song' : ''}`}
                aria-label={`${s.name}${s === current ? ', current' : ''}${s.hidden ? ', hidden' : ''}${session && !s.sections.length ? ', no clips in Live' : ' (tap to queue, hold to jump now)'}`}
                onTap={() => gotoSong(s)}
                onHold={() => gotoSong(s, true)}
              >
                <span className="num">{String(i + 1).padStart(2, '0')}</span>
                <span className="name">{s.name}</span>
                <span className="dur">{s.hidden ? 'HIDDEN' : length(s)}</span>
              </HoldButton>
              {editing && <>
                <button className="mini" aria-label={`Move ${s.name} up`} disabled={i === 0} onClick={() => move(s.id, -1)}>↑</button>
                <button className="mini" aria-label={`Move ${s.name} down`} disabled={i === songs.length - 1} onClick={() => move(s.id, 1)}>↓</button>
                <button className="mini" aria-label={s.hidden ? `Show ${s.name}` : `Hide ${s.name}`} onClick={() => send({ type: 'hide', id: s.id, hidden: !s.hidden })}>{s.hidden ? '○' : '●'}</button>
              </>}
            </div>
          ))}
        </div>
      </aside>

      <main className="main">
        {shown ? (
          <WavePanel key={shown.id} song={shown} wave={waves[shown.id]} elapsed={shown === current ? songBeats : null}
            live={live} session={session} send={send} upcoming={shown !== current} playFrom={playFrom}
            editing={editSections} setEditing={(on) => { setEditSections(on); setSel(null); setLivePad(null); }} sel={sel} setSel={(b) => { setSel(b); setLivePad(null); }}>{queueBox}</WavePanel>
        ) : queueBox}

        <Pads items={padItems} padMidi={state.padMidi} editing={editSections} selected={padSel} onSelect={selectPad} onPress={pressPad} send={send} />

        <Mixer tracks={live.tracks} send={send} />
      </main>

      <nav className="feet" aria-label="Transport">
        <HoldButton className="fs" aria-label="Previous song (hold to jump now)" onTap={() => send({ type: 'prev' })} onHold={() => send({ type: 'prev', immediate: true })}>
          <span className="led" aria-hidden />
          <span className="fs-label"><span aria-hidden>⏮</span> PREV</span>
        </HoldButton>
        <HoldButton className={`fs play lit${playing ? ' playing' : ''}`} aria-label={playing ? 'Stop' : 'Play'} onTap={() => send({ type: playing ? 'stop' : 'play' })}>
          <span className="led" aria-hidden />
          <span className="fs-label"><span aria-hidden>{playing ? '■' : '▶'}</span> {playing ? 'STOP' : 'PLAY'}</span>
        </HoldButton>
        <HoldButton className={`fs${pending ? ' lit' : ''}`} style={{ '--c': pending ? 'var(--queued)' : undefined } as CSSProperties} aria-label="Next song (hold to jump now)" onTap={() => send({ type: 'next' })} onHold={() => send({ type: 'next', immediate: true })}>
          <span className="led" aria-hidden />
          <span className="fs-label"><span aria-hidden>⏭</span> NEXT</span>
          {next && <span className="fs-sub">{next.name}</span>}
        </HoldButton>
      </nav>
    </div>
  );
}

/** keep: still shown on a phone, where the top bar has room for one readout. */
function Readout({ label, value, keep }: { label: string; value: string; keep?: boolean }) {
  return <div className={`readout${keep ? ' keep' : ''}`}><div className="label">{label}</div><div className="value">{value}</div></div>;
}
