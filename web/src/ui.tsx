// Small shared UI pieces: hold-to-confirm button, section colors, connection text.

import { useRef, useState, type ButtonHTMLAttributes } from 'react';
import type { Connection } from '@setdeck/shared';

const HOLD_MS = 600;

type HoldProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & { onTap: () => void; onHold?: () => void };

/** Tap = safe action (queued). Hold, or Shift+click on a keyboard, = deliberate action (jump now). */
export function HoldButton({ onTap, onHold, className = '', children, ...rest }: HoldProps) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const fired = useRef(false);
  const [holding, setHolding] = useState(false);
  const end = () => { clearTimeout(timer.current); setHolding(false); };
  return (
    <button
      {...rest}
      className={`${className} holdable${holding ? ' holding' : ''}`}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (!onHold || e.button !== 0) return;
        fired.current = false;
        setHolding(true);
        timer.current = setTimeout(() => { fired.current = true; setHolding(false); onHold(); }, HOLD_MS);
      }}
      onPointerUp={end}
      onPointerLeave={end}
      onPointerCancel={end}
      onClick={(e) => {
        if (fired.current) { fired.current = false; return; }
        if (e.shiftKey && onHold) onHold(); else onTap();
      }}
    >
      {children}
      {onHold && <span className="hold-fill" aria-hidden />}
    </button>
  );
}

const SECTION_COLORS: [RegExp, string][] = [
  [/pre/i, 'var(--c-amber)'],
  [/intro|start/i, 'var(--c-cyan)'],
  [/verse/i, 'var(--c-blue)'],
  [/chorus|hook|refrain/i, 'var(--c-red)'],
  [/bridge|break/i, 'var(--c-purple)'],
  [/solo|inst/i, 'var(--c-orange)'],
  [/outro|end|tag/i, 'var(--c-green)'],
];
const CYCLE = ['var(--c-pink)', 'var(--c-cyan)', 'var(--c-purple)', 'var(--c-orange)'];
export const sectionColor = (name: string, i: number) => SECTION_COLORS.find(([re]) => re.test(name))?.[1] ?? CYCLE[i % CYCLE.length]!;


export function connectionText(online: boolean, c: Connection | undefined): { ok: boolean; short: string; help: string } {
  if (!online) return { ok: false, short: 'SERVER OFFLINE', help: "Can't reach the SetDeck server. Check it is running on the Mac and this device is on the same Wi-Fi." };
  switch (c) {
    case 'connected': return { ok: true, short: 'LIVE', help: 'Connected to Ableton Live.' };
    case 'port-busy': return { ok: false, short: 'PORT BUSY', help: 'Another program is using port 11001 (the probe or another OSC tool). Close it and SetDeck reconnects by itself.' };
    case 'no-reply': return { ok: false, short: 'NO LIVE', help: 'Live is not answering. Open Live and choose AbletonOSC as a Control Surface in Settings › Link, Tempo & MIDI.' };
    default: return { ok: false, short: 'CONNECTING', help: 'Looking for Ableton Live…' };
  }
}
