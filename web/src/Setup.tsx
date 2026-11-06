// First-run (and redo) setup: the user taps which locators (Arrangement) or scenes (Session) start
// songs; the rest become sections. Each view keeps its own setlist.

import { useMemo, useState } from 'react';
import {
  cueKey, deriveSongs, formatBarBeat, formatTime, resolveMarks, sessionSongs, songSeconds, type AppState, type Command, type View,
} from '@setdeck/shared';
import { connectionText, sectionColor } from './ui.tsx';

type Props = { state: AppState; online: boolean; send: (c: Command) => void; onClose: () => void };

export function Setup({ state, online, send, onClose }: Props) {
  const { songLength, sigNum, sigDen, tempo, scenes } = state.live;
  const session = state.view === 'session';
  const cues = useMemo(
    () => (session ? scenes.map((s) => ({ index: s.index, name: s.name, time: s.index })) : state.live.cues),
    [session, scenes, state.live.cues],
  );
  const sorted = useMemo(() => [...cues].sort((a, b) => a.time - b.time), [cues]);
  const [chosen, setChosen] = useState<Set<string>>(() => {
    const marked = resolveMarks(cues, state.marks);
    return new Set(cues.filter((c) => marked.has(c.index)).map(cueKey));
  });
  const preview = useMemo(
    () => {
      const saved = { order: [], hidden: [], songData: {} };
      return session ? sessionSongs(scenes, [...chosen], saved) : deriveSongs(cues, [...chosen], songLength, saved);
    },
    [session, scenes, cues, chosen, songLength],
  );
  const toggle = (k: string) => setChosen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const firstIsSong = sorted[0] && chosen.has(cueKey(sorted[0]));
  const conn = connectionText(online, state.connection);
  const noun = session ? 'scene' : 'locator';
  const setView = (view: View) => send({ type: 'setView', view });

  return (
    <div className="setup">
      <header>
        <div className="label">Setlist setup</div>
        <div className="seg" role="group" aria-label="Live view" style={{ width: 'fit-content' }}>
          <button aria-pressed={session} onClick={() => setView('session')}>SESSION</button>
          <button aria-pressed={!session} onClick={() => setView('arrangement')}>ARRANGEMENT</button>
        </div>
        <h1>Which {noun}s start a song?</h1>
        <p>The rest become sections of the song before them. Live is not changed.</p>
      </header>

      {cues.length === 0 ? (
        <div className="empty">
          <h2>{conn.ok ? `No ${noun}s in this Live set` : 'Waiting for Live'}</h2>
          <p>{!conn.ok ? conn.help : session
            ? 'In Session view, add a scene for each song section. They appear here by themselves.'
            : 'In Arrangement view, add a locator at the start of each song and at each section (Create › Add Locator). They appear here by themselves.'}</p>
        </div>
      ) : (
        <div className="setup-body">
          <div className="setup-col" role="list" aria-label={session ? 'Scenes' : 'Locators'}>
            <div className="label">{session ? 'Scenes' : 'Locators'} in Live ({cues.length})</div>
            {sorted.map((c) => {
              const k = cueKey(c);
              const song = chosen.has(k);
              return (
                <button key={k} role="listitem" aria-pressed={song} className={`loc ${song ? 'song' : 'section'}`} onClick={() => toggle(k)}>
                  <span className="pos">{session ? `scene ${c.index + 1}` : `bar ${formatBarBeat(c.time, sigNum, sigDen)}`}</span>
                  <span className="name">{c.name || (scenes[c.index]?.isEmpty ? 'Empty scene' : 'Unnamed scene')}</span>
                  <span className="kind">{song ? 'SONG' : session && scenes[c.index]?.isEmpty ? 'SKIPPED' : 'SECTION'}</span>
                </button>
              );
            })}
          </div>
          <div className="setup-col" aria-label="Preview">
            <div className="label">Preview: {preview.length} songs</div>
            {!firstIsSong && chosen.size > 0 && <p>{session ? 'Scenes' : 'Locators'} before the first song are ignored.</p>}
            {preview.length === 0 && <p>Tap a {noun} on the left to make it a song.</p>}
            {preview.map((s, i) => (
              <div key={s.id} className="pv-song">
                <div className="pv-name"><span>{i + 1}. {s.name}</span><span className="label">{!session ? formatTime(songSeconds(s, tempo)) : s.sections.length ? `${s.sections.length} scenes` : 'NO CLIPS IN LIVE'}</span></div>
                <div className="pv-sections">
                  {s.sections.map((x, j) => <span key={x.start} className="chip" style={{ '--c': sectionColor(x.name, j) } as React.CSSProperties}>{x.name}</span>)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <footer>
        {state.setupDone && <button className="btn" onClick={onClose}>Back</button>}
        <button
          className="btn primary"
          disabled={chosen.size === 0}
          onClick={() => { send({ type: 'setup', cueKeys: [...chosen] }); onClose(); }}
        >
          Use this setlist ({preview.length} songs)
        </button>
      </footer>
    </div>
  );
}
