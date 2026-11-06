// App data in ~/.setdeck/setdeck.json: versioned, written atomically (temp file + rename),
// and a corrupt file is kept aside instead of being overwritten.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MidiBinding, Saved, View, Wave } from '@setdeck/shared';

export const VERSION = 1;
export type Data = Saved & { version: number; view: View; marks: string[] | null; sessionMarks: string[] | null; waves: Record<string, Wave>;
  padMidi: (MidiBinding | null)[];
  /** Clip starts moved by a clip jump, put back once the clip stops playing (`on`: Live has played it). */
  restore: { track: number; scene: number; start: number; on?: boolean }[];
};

export const defaults = (): Data => ({ version: VERSION, view: 'session', marks: null, sessionMarks: null, order: [], hidden: [], songData: {}, waves: {}, padMidi: [], restore: [] });

const dir = () => process.env.SETDECK_HOME ?? join(homedir(), '.setdeck');
const file = () => join(dir(), 'setdeck.json');

export function load(): Data {
  if (!existsSync(file())) return defaults();
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Data>;
    // ponytail: only v1 exists; add migrations here keyed on raw.version when the shape changes.
    return { ...defaults(), ...raw, version: VERSION };
  } catch (e) {
    const aside = `${file()}.bad-${Date.now()}`;
    renameSync(file(), aside);
    console.error(`Could not read ${file()} (${(e as Error).message}). Kept it as ${aside} and started fresh.`);
    return defaults();
  }
}

export function save(data: Data) {
  mkdirSync(dir(), { recursive: true });
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file());
}
