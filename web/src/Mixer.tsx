// Mixer laid out like Live's: the top-level tracks, and group tracks that open to show the tracks
// inside them, nested exactly as in Live (structure from Live's group_track). Changes go straight to
// Live. Each strip: fader, mute, solo.

import { useState, type CSSProperties, type ReactNode } from 'react';
import type { Command, Track } from '@setdeck/shared';

const UNITY = 0.85; // Live's 0 dB fader position
const hex = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
const KEY = 'setdeck.mixer.open'; // open groups, by name, per device
const readOpen = (): Set<string> => {
  try { return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]); } catch { return new Set(); }
};

type Props = { tracks: Track[]; send: (c: Command) => void };

export function Mixer({ tracks, send }: Props) {
  // While a fader is held, show the finger's value, not Live's echo (it lags a little).
  const [held, setHeld] = useState<Record<number, number>>({});
  const [open, setOpen] = useState<Set<string>>(readOpen);
  const release = (i: number) => setHeld((h) => { const n = { ...h }; delete n[i]; return n; });
  const set = (track: number, prop: 'volume' | 'mute' | 'solo', value: number) => send({ type: 'mix', track, prop, value });
  const keep = (s: Set<string>) => { setOpen(s); try { localStorage.setItem(KEY, JSON.stringify([...s])); } catch { /* private mode */ } };
  const toggle = (name: string) => { const s = new Set(open); if (s.has(name)) s.delete(name); else s.add(name); keep(s); };

  const kids = new Map<number, Track[]>();
  for (const t of tracks) kids.set(t.parent, [...(kids.get(t.parent) ?? []), t]);

  const strip = (t: Track, isOpen: boolean) => {
    const name = t.name || `Track ${t.index + 1}`;
    const v = held[t.index] ?? t.volume;
    const count = kids.get(t.index)?.length ?? 0;
    return (
      <div key={`s${t.index}`} className={`strip${t.mute ? ' muted' : ''}${t.isGroup ? ' group' : ''}`} style={{ '--c': hex(t.color) } as CSSProperties}>
        {t.isGroup ? (
          <button className="strip-name fold" aria-expanded={isOpen} title={name}
            aria-label={`${isOpen ? 'Close' : 'Open'} group ${name}, ${count} tracks`} onClick={() => toggle(t.name)}>
            <span aria-hidden>{isOpen ? '▾' : '▸'}</span> {name}
          </button>
        ) : <div className="strip-name" title={name}>{name}</div>}
        <div className="fader-wrap">
          <i className="unity" aria-hidden />
          <input
            type="range" className="fader" min={0} max={1} step={0.005} value={v} aria-label={`${name} volume`} title="Double-click: 0 dB"
            style={{ '--v': `${v * 100}%` } as CSSProperties}
            onChange={(e) => { const x = Number(e.target.value); setHeld((h) => ({ ...h, [t.index]: x })); set(t.index, 'volume', x); }}
            onPointerUp={() => release(t.index)} onKeyUp={() => release(t.index)} onBlur={() => release(t.index)}
            onDoubleClick={() => set(t.index, 'volume', UNITY)}
          />
        </div>
        <div className="strip-btns">
          <button className="ms mute" aria-pressed={t.mute} aria-label={`Mute ${name}`} onClick={() => set(t.index, 'mute', t.mute ? 0 : 1)}>M</button>
          <button className="ms solo" aria-pressed={t.solo} aria-label={`Solo ${name}`} onClick={() => set(t.index, 'solo', t.solo ? 0 : 1)}>S</button>
        </div>
      </div>
    );
  };
  // An open group is drawn as a bracket in its color: the group strip, then its tracks (and open sub-groups).
  const render = (t: Track): ReactNode => {
    const isOpen = t.isGroup && open.has(t.name);
    if (!isOpen) return strip(t, false);
    return (
      <div key={`g${t.index}`} className="strip-group" role="group" aria-label={`Group ${t.name}`} style={{ '--c': hex(t.color) } as CSSProperties}>
        {strip(t, true)}
        {(kids.get(t.index) ?? []).map(render)}
      </div>
    );
  };
  const anyOpen = tracks.some((t) => t.isGroup && open.has(t.name));

  return (
    <section className="mixer-panel" aria-label="Mixer">
      {tracks.length === 0 ? <p className="muted">No tracks from Live yet.</p> : (
        <div className="mixer">
          {anyOpen && <button className="icon-btn close-all" onClick={() => keep(new Set())}>CLOSE ALL</button>}
          {(kids.get(-1) ?? []).map(render)}
        </div>
      )}
    </section>
  );
}
