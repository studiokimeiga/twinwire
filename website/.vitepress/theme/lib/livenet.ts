// Twinwire's real GameServer, running in the page. GameServer takes its WebSocket module as a constructor argument;
// here that module is a stand-in whose sockets cross a simulated network (latency, jitter, and an "offline" switch)
// to browser-side sockets with the shape GameClient expects. Everything above the socket is the library's own code.
import { GameServer, type GameServerOptions } from 'twinwire/server';

const ORIGIN = 'https://play.twinwire.example';
export const LIVE_URL = 'wss://play.twinwire.example/connect';

type Listener = (...args: unknown[]) => void;
interface Req { headers: Record<string, string>; socket: { remoteAddress: string } }

export interface LiveEvent { t: number; kind: 'attempt' | 'refused' | 'open' | 'close'; conn: number; code?: number }

export class LiveNet {
  latency = 40;
  jitter = 10;
  private offline_ = false;
  readonly server: GameServer;
  readonly log: LiveEvent[] = [];
  onLog: (e: LiveEvent) => void = () => {};
  private accept?: (ws: ServerSocket, req: Req) => void;
  readonly sockets = new Set<BrowserSocket>();
  private nextConn = 1;

  constructor(options: Omit<GameServerOptions, 'origins'>) {
    const net = this;
    const wsModule = {
      WebSocketServer: class {
        constructor(_o: Record<string, unknown>) {}
        on(type: string, cb: (ws: ServerSocket, req: Req) => void) { if (type === 'connection') net.accept = cb; }
        close() {}
      },
    };
    this.server = new GameServer({ origins: [ORIGIN], ...options }, wsModule as never);
  }
  start() { return this.server.listen(); }
  stop() { for (const s of [...this.sockets]) s.drop(1006); void this.server.close(); }

  get offline() { return this.offline_; }
  /** The browser loses its network: open connections die, and new ones fail until it comes back. */
  set offline(v: boolean) {
    this.offline_ = v;
    if (v) for (const s of [...this.sockets]) s.drop(1006);
  }
  delay() { return this.latency + Math.random() * this.jitter; }
  note(e: Omit<LiveEvent, 't'>) { const full = { t: performance.now(), ...e }; this.log.push(full); if (this.log.length > 500) this.log.shift(); this.onLog(full); }

  /** Pass as GameClient's `websocket` option. */
  readonly websocket = (url: string): WebSocket => new BrowserSocket(this, url, this.nextConn++) as unknown as WebSocket;

  /** @internal */ connect(b: BrowserSocket) {
    this.note({ kind: 'attempt', conn: b.id });
    if (this.offline_) { setTimeout(() => { this.note({ kind: 'refused', conn: b.id }); b.closed(1006, ''); }, this.latency * 2 + 300); return; }
    setTimeout(() => {
      if (b.readyState !== 0) return;
      if (this.offline_) { this.note({ kind: 'refused', conn: b.id }); b.closed(1006, ''); return; }
      const s = new ServerSocket(this, b); b.peer = s; this.sockets.add(b);
      this.accept?.(s, { headers: { origin: ORIGIN }, socket: { remoteAddress: '203.0.113.' + (b.id % 250) } });
      setTimeout(() => { if (b.readyState === 0) { b.readyState = 1; this.note({ kind: 'open', conn: b.id }); b.onopen?.(new Event('open')); } }, this.delay());
    }, this.delay());
  }
}

/** The browser's end: what GameClient talks to instead of a WebSocket. */
class BrowserSocket {
  readyState = 0;
  binaryType = 'arraybuffer';
  readonly bufferedAmount = 0;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  peer?: ServerSocket;
  private tail = 0;
  constructor(private net: LiveNet, readonly url: string, readonly id: number) { net.connect(this); }
  send(data: string | ArrayBuffer | Uint8Array) {
    if (this.readyState !== 1 || !this.peer) return;
    const at = this.tail = Math.max(this.tail, performance.now() + this.net.delay()), peer = this.peer;
    const raw = typeof data === 'string' ? data : new Uint8Array(data instanceof Uint8Array ? data.slice() : data.slice(0));
    setTimeout(() => peer.receive(raw), at - performance.now());
  }
  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    const peer = this.peer;
    setTimeout(() => peer?.closed(code, reason), this.net.delay());
    setTimeout(() => this.closed(code, reason), this.net.delay() * 2);
  }
  /** The connection is gone, without a goodbye (the network dropped). */
  drop(code: number) { const peer = this.peer; this.closed(code, ''); setTimeout(() => peer?.closed(code, ''), this.net.delay()); }
  /** @internal */ closed(code: number, reason: string) {
    if (this.readyState === 3) return;
    this.readyState = 3; this.net.sockets.delete(this);
    this.net.note({ kind: 'close', conn: this.id, code });
    this.onclose?.({ code, reason });
  }
  /** @internal */ receive(data: string | Uint8Array) {
    if (this.readyState !== 1) return;
    this.onmessage?.({ data: typeof data === 'string' ? data : data.slice().buffer });
  }
}

/** The server's end, in the shape of a `ws` socket. */
class ServerSocket {
  readyState = 1;
  readonly bufferedAmount = 0;
  private listeners: Record<string, Listener[]> = {};
  private tail = 0;
  constructor(private net: LiveNet, private browser: BrowserSocket) {}
  on(type: string, cb: Listener) { (this.listeners[type] ??= []).push(cb); }
  send(data: string | Uint8Array) {
    if (this.readyState !== 1) return;
    const at = this.tail = Math.max(this.tail, performance.now() + this.net.delay()), b = this.browser;
    const copy = typeof data === 'string' ? data : data.slice();
    setTimeout(() => b.receive(copy), at - performance.now());
  }
  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 2; const b = this.browser;
    setTimeout(() => b.closed(code, reason), this.net.delay());
    setTimeout(() => this.closed(code, reason), 0);
  }
  terminate() { this.close(1006, ''); }
  /** @internal */ closed(_code: number, _reason: string) {
    if (this.readyState === 3) return;
    this.readyState = 3; for (const f of this.listeners.close ?? []) f();
  }
  /** @internal */ receive(data: string | Uint8Array) {
    if (this.readyState !== 1) return;
    const text = typeof data === 'string' ? data : null;
    const raw = text !== null ? new TextEncoder().encode(text) : data as Uint8Array;
    if (text !== null) (raw as Uint8Array & { toString(): string }).toString = () => text;
    for (const f of this.listeners.message ?? []) f(raw, text === null);
  }
}
