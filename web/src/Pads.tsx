// Drum pads: the current song's sections, in order (pad 1 = first section). Pressing one plays that
// section at once, no waiting for the bar. A pad's name is its section's name, so renaming a
// pad renames the section (in EDIT, tap a pad, then pick or type a name in the waveform panel).
// A hardware drum pad learned with LEARN MIDI presses the same pad position in every song. MIDI comes in
// through Web MIDI, so the controller is read by the SetDeck window on the Mac (iPad Safari has none).

import { useEffect, useRef, useState } from 'react';
import { midiText, parseMidi, sameMidi, type Command, type MidiBinding } from '@setdeck/shared';

const hasMidi = typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;

export type PadItem = { name: string; on: boolean; queued: boolean };
type Props = {
  items: PadItem[];
  padMidi: (MidiBinding | null)[];
  editing: boolean;
  selected: number | null;
  onSelect: (i: number) => void;
  onPress: (i: number) => void;
  send: (c: Command) => void;
};

export function Pads({ items, padMidi, editing, selected, onSelect, onPress, send }: Props) {
  const [learning, setLearning] = useState(false);
  const learnOn = learning && editing && selected !== null;

  // The MIDI handler is attached once; it reads the latest values through this ref.
  const latest = useRef({ items, padMidi, selected, learnOn, onPress });
  useEffect(() => { latest.current = { items, padMidi, selected, learnOn, onPress }; });

  useEffect(() => {
    if (!hasMidi) return;
    let access: MIDIAccess | undefined;
    const onMessage = (e: MIDIMessageEvent) => {
      const b = e.data ? parseMidi(e.data) : null;
      if (!b) return;
      const { items, padMidi, selected, learnOn, onPress } = latest.current;
      if (learnOn && selected !== null) {
        // one drum pad per pad: if it was linked to another pad, it moves here
        const next = Array.from({ length: Math.max(padMidi.length, selected + 1) }, (_, i) => (i === selected ? b : sameMidi(padMidi[i] ?? undefined, b) ? null : padMidi[i] ?? null));
        send({ type: 'setPadMidi', pads: next });
        setLearning(false);
        return;
      }
      const i = padMidi.findIndex((m) => sameMidi(m ?? undefined, b));
      // ponytail: every open SetDeck window with Web MIDI acts on the controller; keep one open on the Mac
      if (i >= 0 && i < items.length) onPress(i);
    };
    const attach = () => access?.inputs.forEach((input) => { input.onmidimessage = onMessage; });
    navigator.requestMIDIAccess().then((a) => { access = a; attach(); a.onstatechange = attach; }).catch(() => { /* no permission */ });
    return () => {
      access?.inputs.forEach((input) => { input.onmidimessage = null; });
      if (access) access.onstatechange = null;
    };
  }, [send]);

  const bound = selected !== null ? padMidi[selected] : null;
  return (
    <section className="pads-panel" aria-label="Drum pads">
      <div className="pads">
        {items.map((p, i) => {
          const midi = padMidi[i];
          const cls = `pad${p.name ? '' : ' blank'}${p.on ? ' on' : ''}${p.queued ? ' queued' : ''}${editing && selected === i ? ' sel' : ''}${learnOn && selected === i ? ' learning' : ''}`;
          const body = <>{p.name ? <span className="pad-name">{p.name}</span> : <span className="pad-num">{i + 1}</span>}{midi && <span className="pad-midi">{midiText(midi)}</span>}</>;
          const label = `Pad ${i + 1}: ${p.name || 'empty'}${p.on ? ', playing' : ''}${p.queued ? ', queued' : ''}`;
          return editing ? (
            <button key={i} className={cls} aria-pressed={selected === i} aria-label={`Edit ${label}`} onClick={() => { onSelect(i); setLearning(false); }}>{body}</button>
          ) : (
            <button key={i} className={cls} aria-label={label} onPointerDown={(e) => { if (e.button === 0) onPress(i); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onPress(i); } }}>{body}</button>
          );
        })}
        {editing && (
          <div className="pad-tools">
            <button className={`chipbtn${learnOn ? ' learning' : ''}`} disabled={!hasMidi || selected === null}
              title={hasMidi ? 'Tap a pad, then this, then hit your drum pad' : 'Works in the SetDeck app on the Mac'}
              onClick={() => setLearning(!learning)}>{learnOn ? 'HIT A DRUM PAD…' : 'LEARN MIDI'}</button>
            {bound && (
              <button className="chipbtn danger" onClick={() => send({ type: 'setPadMidi', pads: padMidi.map((m, i) => (i === selected ? null : m)) })}>
                CLEAR MIDI
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
