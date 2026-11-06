// UDP OSC client for AbletonOSC: request/response by address, timeouts, and a heartbeat that
// tracks connection state and survives Live quitting or the script being disabled.

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { Message, encode, decode } from 'node-osc';
import type { Connection } from '@setdeck/shared';
import { OSC, LIVE_PORT, REPLY_PORT, type SongProp, type SongRwProp, type TrackProp, type TrackRwProp } from './osc-map.ts';

export type Arg = string | number | boolean | null;
type Waiter = { match: (args: Arg[]) => boolean; resolve: (args: Arg[]) => void };

export type OscOptions = { host?: string; port?: number; replyPort?: number; timeoutMs?: number };

/** Emits 'message' (address, args) for every incoming message and 'status' (Connection) on change. */
export class OscClient extends EventEmitter {
  status: Connection = 'starting';
  private sock = dgram.createSocket('udp4');
  private waiters = new Map<string, Waiter[]>();
  private taps = new Set<(address: string, args: Arg[]) => void>();
  private heartbeat?: NodeJS.Timeout;
  private downSince = 0;
  readonly host: string;
  readonly port: number;
  readonly replyPort: number;
  readonly timeoutMs: number;

  constructor(o: OscOptions = {}) {
    super();
    this.host = o.host ?? '127.0.0.1';
    this.port = o.port ?? LIVE_PORT;
    this.replyPort = o.replyPort ?? REPLY_PORT;
    this.timeoutMs = o.timeoutMs ?? 1500;
    this.sock.on('message', (buf) => {
      let msg;
      try { msg = decode(buf); } catch { return; }
      if (msg.oscType !== 'message') return;
      const args: Arg[] = msg.args.map((a: { value: Arg }) => a.value);
      for (const tap of this.taps) tap(msg.address, args);
      this.emit('message', msg.address, args);
      const list = this.waiters.get(msg.address);
      const i = list?.findIndex((w) => w.match(args)) ?? -1;
      if (list && i >= 0) list.splice(i, 1)[0]!.resolve(args);
    });
  }

  bind(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sock.once('error', reject);
      this.sock.bind(this.replyPort, () => { this.sock.off('error', reject); resolve(); });
    });
  }

  /** Bind (retrying while the port is busy) and keep checking that AbletonOSC answers. */
  async start(intervalMs = 1000) {
    for (;;) {
      try { await this.bind(); break; } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
        this.setStatus('port-busy');
        this.sock = this.recreate();
        await sleep(3000);
      }
    }
    // Live is only "gone" after 3 missed beats in a row: a busy Live (big set, many requests) can be
    // late with one reply, and calling that a disconnect triggers a full resync that makes it busier.
    let misses = 0;
    const beat = async () => {
      try { await this.request(OSC.app.test); misses = 0; this.setStatus('connected'); } catch {
        if (++misses >= 3 || this.status !== 'connected') this.setStatus('no-reply');
      }
      this.heartbeat = setTimeout(beat, intervalMs);
    };
    await beat();
    // AbletonOSC restarted (Live reopened, script re-enabled): resubscribe.
    this.on('message', (a: string) => { if (a === OSC.app.startup) this.emit('resync'); });
  }

  private recreate() {
    const listeners = this.sock.listeners('message') as ((buf: Buffer) => void)[];
    const s = dgram.createSocket('udp4');
    for (const l of listeners) s.on('message', l);
    return s;
  }

  private setStatus(s: Connection) {
    if (s === this.status) return;
    const was = this.status;
    this.status = s;
    this.emit('status', s);
    if (was === 'connected') this.downSince = Date.now();
    // Resubscribe on the first connection or after a real outage. After a short gap Live was only busy
    // and still holds our listeners; resubscribing a big set then would make it busier still (that loop
    // made song changes lag). A restarted AbletonOSC announces itself with /live/startup, see start().
    if (s === 'connected' && (this.downSince === 0 || Date.now() - this.downSince > 20_000)) this.emit('resync');
  }

  close() { clearTimeout(this.heartbeat); this.sock.close(); }

  send(address: string, ...args: Arg[]) {
    this.sock.send(encode(new Message(address, ...args)), this.port, this.host);
  }

  /** Send and wait for the reply on the same address. Rejects on timeout (AbletonOSC is silent on errors). */
  request(address: string, args: Arg[] = [], match: (a: Arg[]) => boolean = () => true): Promise<Arg[]> {
    return new Promise((resolve, reject) => {
      const w: Waiter = { match, resolve: (a) => { clearTimeout(t); resolve(a); } };
      const list = this.waiters.get(address) ?? [];
      list.push(w);
      this.waiters.set(address, list);
      const t = setTimeout(() => {
        list.splice(list.indexOf(w), 1);
        reject(new Error(`no reply to ${address} within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.send(address, ...args);
    });
  }

  /** Record every message on `address` for `ms` milliseconds, with arrival times. */
  async collect(address: string, ms: number): Promise<{ t: number; args: Arg[] }[]> {
    const out: { t: number; args: Arg[] }[] = [];
    const tap = (a: string, args: Arg[]) => { if (a === address) out.push({ t: performance.now(), args }); };
    this.taps.add(tap);
    await sleep(ms);
    this.taps.delete(tap);
    return out;
  }

  songGet = async (p: SongProp) => (await this.request(OSC.song.get(p)))[0] ?? null;
  songSet = (p: SongRwProp, v: Arg) => this.send(OSC.song.set(p), v);
  trackGet = async (p: TrackProp, i: number) => (await this.request(OSC.track.get(p), [i], (a) => a[0] === i))[1] ?? null;
  trackSet = (p: TrackRwProp, i: number, v: Arg) => this.send(OSC.track.set(p), i, v);
}
