import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { Endpoint, type EndpointOptions, type Impairment, type StateMessage, type StateOptions } from '../core/endpoint.js';
import { TokenBucket } from '../core/budget.js';
import { readControl, record as isRecord, stringify, VERSION, MAX_CONTROL_BYTES, isUint, type Json, type JsonInput } from '../core/protocol.js';
import { validIceServers, validSignal, type IceServer, type RtcPeer } from '../core/rtc.js';
import type { RtcFactory } from './rtc.js';
interface Ws {
  readyState: number; bufferedAmount: number;
  send(data: string | Uint8Array): void; close(code?: number, reason?: string): void; terminate(): void;
  on(type: 'message', cb: (data: Buffer, binary: boolean) => void): void;
  on(type: 'close' | 'error', cb: () => void): void;
}
interface WsServer { on(type: 'connection', cb: (ws: Ws, req: IncomingMessage) => void): void; close(): void }
interface WsModule { WebSocketServer: new (o: Record<string, unknown>) => WsServer }
export interface GameServerOptions {
  port?: number; host?: string; path?: string;
  /** Exact page origins, or a predicate (for example, any origin for a game without cookies or accounts). */
  origins: string[] | ((origin: string) => boolean);
  allowMissingOrigin?: boolean; maxSessions?: number; maxConnections?: number; maxPerIp?: number;
  /** Sessions one address may hold, connected or waiting to resume (default maxPerIp). At the limit, a new session
   * from that address replaces its longest-disconnected one, so a player who reloads a lot recycles their own. */
  maxSessionsPerIp?: number;
  resumeGraceMs?: number; heartbeatTimeoutMs?: number; handshakeTimeoutMs?: number;
  /** How often queued states and events go out (default 60 Hz). A game ticking faster (a 64 or 128 Hz shooter) sets
   * its tick rate here, or calls session.flush() after each snapshot; otherwise ticks between pumps are coalesced. */
  pumpHz?: number;
  endpoint?: EndpointOptions; rtc?: RtcFactory;
  /** STUN/TURN servers handed to each client in its welcome (a function can mint per-session TURN credentials). */
  iceServers?: IceServer[] | ((session: GameSession) => IceServer[] | Promise<IceServer[]>);
  /** Behind one reverse proxy (Caddy, nginx) on this machine: take the client address from X-Forwarded-For. */
  trustProxy?: boolean;
  /** Development only: honour a client's request to impair this server's sends to it. */
  allowImpairment?: boolean;
  /** Messages per second and bytes per second each connection may send (defaults 300 and 256 KiB). */
  rateLimit?: { messages?: number; bytes?: number };
  /** A stable account subject, or null to reject. Omit for anonymous rooms. Revalidated on resume. */
  authenticate?: (request: { room: string; auth: Json; resuming: boolean; ip: string }) => string | null | Promise<string | null>;
  onSession?: (session: GameSession, resumed: boolean) => void;
  onDisconnect?: (session: GameSession) => void;
  onExpire?: (session: GameSession) => void;
  onError?: (error: Error) => void;
  http?: (req: IncomingMessage, res: ServerResponse) => void;
}
export class GameSession {
  readonly endpoint: Endpoint;
  connected = false;
  disconnectedAt = 0;
  epoch = 0;
  /** Address of the current (or last) connection. */
  ip = '';
  /** The application JSON the client sent as `auth` with its latest hello (names, build ids). Validate before use. */
  hello: Json = null;
  /** Free for the application (player record, room membership). */
  data: unknown = undefined;
  constructor(readonly id: string, readonly room: string, readonly subject: string | null, options: EndpointOptions = {}) {
    this.endpoint = new Endpoint(options);
  }
  sendEvent(data: JsonInput) { return this.endpoint.sendEvent(data); }
  /** Send what is queued now instead of at the next 60 Hz pump (latency-sensitive streams). */
  flush() { this.endpoint.flush(); }
  sendState(stream: number, data: Uint8Array, options?: StateOptions) {
    return this.endpoint.sendState(stream, data, performance.now(), options);
  }
  set onState(cb: (state: StateMessage) => void) { this.endpoint.onState = cb; }
  set onEvent(cb: (data: Json, seq: number) => void) { this.endpoint.onEvent = cb; }
  set onStateAck(cb: (stream: number, seq: number) => void) { this.endpoint.onStateAck = cb; }
  get transport(): 'rtc' | 'ws' | 'none' { return !this.connected ? 'none' : this.endpoint.fastActive ? 'rtc' : 'ws'; }
}
interface SessionRecord { session: GameSession; token: string; connection?: Connection }
interface Connection {
  ws: Ws; ip: string; started: number; lastSeen: number; authenticating: boolean;
  record?: SessionRecord; epoch: number; rtc?: RtcPeer; attempt: number; rtcStarted: number;
  messages: TokenBucket; bytes: TokenBucket;
}
type Hook = 'session' | 'disconnect' | 'expire';
type HookFn<H extends Hook> = H extends 'session' ? (s: GameSession, resumed: boolean) => void : (s: GameSession) => void;
export class GameServer {
  readonly sessions = new Map<string, GameSession>();
  readonly stats = { connectionsAccepted: 0, protocolErrors: 0, rateLimited: 0, sessionResumes: 0, expiredSessions: 0 };
  private tokens = new Map<string, SessionRecord>();
  private connections = new Set<Connection>();
  private epoch = randomBytes(4).readUInt32LE(0) || 1;
  private timer?: ReturnType<typeof setInterval>;
  private shuttingDown = false;
  private wsServer: WsServer;
  readonly httpServer: HttpServer;
  private pumpCursor = 0;
  private hooks: { [H in Hook]: HookFn<H>[] } = { session: [], disconnect: [], expire: [] };
  private maxFrame: number;
  constructor(readonly options: GameServerOptions, ws: WsModule) {
    if (typeof options.origins !== 'function' && (!Array.isArray(options.origins) || options.origins.some(s => typeof s !== 'string' || s === '*')))
      throw new Error('Supply exact permitted origins, not a wildcard');
    if (options.pumpHz !== undefined && !(options.pumpHz >= 10 && options.pumpHz <= 250)) throw new RangeError('pumpHz must be 10 to 250');
    this.maxFrame = new Endpoint(options.endpoint).maxFrameBytes;
    this.httpServer = createServer((req, res) => {
      if (options.http) options.http(req, res); else { res.writeHead(404); res.end(); }
    });
    this.wsServer = new ws.WebSocketServer({ server: this.httpServer, path: options.path ?? '/connect',
      maxPayload: Math.max(MAX_CONTROL_BYTES, this.maxFrame), perMessageDeflate: false });
    this.wsServer.on('connection', (socket, req) => this.connect(socket, req));
  }
  /** Add a listener next to the options' callbacks (used by Lobby). */
  on<H extends Hook>(hook: H, fn: HookFn<H>): () => void {
    const list = this.hooks[hook] as HookFn<H>[]; list.push(fn);
    return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
  }
  private emit(hook: Hook, s: GameSession, resumed = false) {
    const own = hook === 'session' ? this.options.onSession : hook === 'disconnect' ? this.options.onDisconnect : this.options.onExpire;
    for (const fn of [...this.hooks[hook], ...(own ? [own] : [])]) {
      try { (fn as (s: GameSession, r: boolean) => void)(s, resumed); } catch (e) { this.report(e); }
    }
  }
  async listen(): Promise<number> {
    if (this.timer) throw new Error('Already listening');
    await new Promise<void>((resolve, reject) => {
      const error = (e: Error) => reject(e); this.httpServer.once('error', error);
      this.httpServer.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1', () => { this.httpServer.off('error', error); resolve(); });
    });
    this.timer = setInterval(() => this.pump(), 1000 / (this.options.pumpHz ?? 60));
    return (this.httpServer.address() as { port: number }).port;
  }
  private report(error: unknown) {
    try { this.options.onError?.(error instanceof Error ? error : new Error(String(error))); }
    catch { /* A diagnostics callback must not stop the room pump. */ }
  }
  /** The client address, honouring one trusted local proxy when configured. */
  addressOf(req: IncomingMessage): string {
    const peer = req.socket.remoteAddress ?? 'unknown';
    if (this.options.trustProxy && /^(127\.|::1$|::ffff:127\.)/.test(peer)) {
      const f = req.headers['x-forwarded-for'], list = (Array.isArray(f) ? f.join(',') : f ?? '').split(',').map(s => s.trim()).filter(Boolean);
      if (list.length) return list[list.length - 1]!.slice(0, 64);
    }
    return peer;
  }
  private connect(ws: Ws, req: IncomingMessage): void {
    const origin = req.headers.origin, ip = this.addressOf(req);
    const allowed = (o: string) => typeof this.options.origins === 'function' ? this.options.origins(o) : this.options.origins.includes(o);
    if (this.shuttingDown || (origin ? !allowed(origin) : !this.options.allowMissingOrigin)) { ws.close(1008, 'origin'); return; }
    let fromIp = 0; for (const c of this.connections) if (c.ip === ip) fromIp++;
    if (this.connections.size >= (this.options.maxConnections ?? 512) || fromIp >= (this.options.maxPerIp ?? 32)) {
      ws.close(1013, 'capacity'); return;
    }
    const now = performance.now(), rate = this.options.rateLimit ?? {};
    const msgs = rate.messages ?? 300, bytes = rate.bytes ?? 256 * 1024;
    const c: Connection = { ws, ip, started: now, lastSeen: now, authenticating: false, epoch: 0, attempt: 0, rtcStarted: 0,
      messages: new TokenBucket(msgs, msgs * 2, now), bytes: new TokenBucket(bytes, Math.max(bytes * 2, this.maxFrame * 2), now) };
    this.connections.add(c); this.stats.connectionsAccepted++;
    ws.on('error', () => {});
    ws.on('close', () => this.disconnect(c));
    ws.on('message', (raw, binary) => {
      if (!this.connections.has(c) || c.record && c.record.connection !== c) return;
      const now = performance.now(); c.lastSeen = now;
      if (!c.messages.take(1, now) || !c.bytes.take(raw.byteLength, now)) { this.stats.rateLimited++; ws.close(1008, 'rate'); return; }
      try {
        if (binary) {
          if (!c.record || raw.length > this.maxFrame) throw new Error('Unexpected binary frame');
          c.record.session.endpoint.receiveBinary(new Uint8Array(raw), 'ws');
        } else {
          if (c.record) c.record.session.endpoint.stats.bytesReceived += raw.byteLength;
          const m = readControl(raw.toString('utf8')); if (!m) throw new Error('Invalid control');
          if (m.t === 'hello') { void this.hello(c, m).catch(e => { this.report(e); ws.close(1008, 'join'); }); }
          else this.message(c, m);
        }
      } catch (error) { this.stats.protocolErrors++; this.report(error); ws.close(1002, 'protocol'); }
    });
  }
  private async hello(c: Connection, m: Record<string, unknown>): Promise<void> {
    if (c.record || c.authenticating || m.v !== VERSION || typeof m.room !== 'string' ||
        !/^[\w:.-]{1,64}$/.test(m.room) || !(m.token === null || typeof m.token === 'string' && /^[\w-]{20,128}$/.test(m.token)))
      throw new Error('Invalid hello');
    c.authenticating = true;
    const auth = (m.auth ?? null) as Json;
    const subject = this.options.authenticate ? await this.options.authenticate({ room: m.room, auth, resuming: !!m.token, ip: c.ip }) : null;
    if (!this.connections.has(c) || c.ws.readyState !== 1 || this.shuttingDown) return;
    if (this.options.authenticate && (typeof subject !== 'string' || !subject)) throw new Error('Authentication rejected');
    let record: SessionRecord | undefined;
    const resumed = typeof m.token === 'string';
    if (resumed) {
      record = this.tokens.get(m.token as string);
      if (!record || record.session.room !== m.room || record.session.subject !== subject ||
          !record.session.connected && performance.now() - record.session.disconnectedAt > (this.options.resumeGraceMs ?? 90000)) {
        c.ws.send(JSON.stringify({ t: 'reset', reason: 'session unavailable' })); c.ws.close(4001, 'session unavailable'); return;
      }
      this.stats.sessionResumes++;
    } else {
      const mine = [...this.tokens.values()].filter(r => r.session.ip === c.ip);
      if (mine.length >= (this.options.maxSessionsPerIp ?? this.options.maxPerIp ?? 32)) {
        const idle = mine.filter(r => !r.session.connected).sort((a, b) => a.session.disconnectedAt - b.session.disconnectedAt)[0];
        if (!idle) { c.ws.close(1013, 'too many sessions from this address'); return; }
        this.expire(idle);
      }
      if (this.sessions.size >= (this.options.maxSessions ?? 256)) { c.ws.close(1013, 'room capacity'); return; }
      const session = new GameSession(randomUUID(), m.room, subject, this.options.endpoint);
      session.endpoint.onCallbackError = e => this.report(e);
      record = { session, token: randomBytes(32).toString('base64url') };
      this.sessions.set(session.id, session); this.tokens.set(record.token, record);
    }
    const s = record.session;
    let ice: IceServer[] = [];
    try {
      const v = typeof this.options.iceServers === 'function' ? await this.options.iceServers(s) : this.options.iceServers ?? [];
      if (validIceServers(v)) ice = v; else this.report(new Error('Invalid iceServers ignored'));
    } catch (e) { this.report(e); }
    if (!this.connections.has(c) || c.ws.readyState !== 1 || this.shuttingDown) return;
    const old = record.connection;
    if (old && old !== c) { this.stopRtc(old, false); old.record = undefined; old.ws.close(4002, 'session resumed elsewhere'); }
    record.connection = c; c.record = record; c.authenticating = false;
    c.epoch = this.epoch = (this.epoch + 1) >>> 0 || 1; s.epoch = c.epoch; s.connected = true; s.ip = c.ip; s.hello = auth;
    try { s.endpoint.setImpairment(this.options.allowImpairment && isRecord(m.impair) ? m.impair as Impairment : null); }
    catch (e) { this.report(e); s.endpoint.setImpairment(null); }
    const socket = c.ws;
    s.endpoint.attach(c.epoch, {
      get open() { return socket.readyState === 1; }, get bufferedAmount() { return socket.bufferedAmount; },
      send(data) { if (socket.readyState !== 1) return false; socket.send(data); return true; }, close() { socket.close(); },
    });
    s.endpoint.onFastDown = () => this.stopRtc(c, true);
    s.endpoint.sendControl({ t: 'welcome', v: VERSION, e: c.epoch, id: s.id, token: record.token, resumed, rtc: !!this.options.rtc, ice: ice as unknown as Json });
    this.emit('session', s, resumed); s.endpoint.flush();
  }
  private message(c: Connection, m: Record<string, unknown>): void {
    const r = c.record;
    if (!r || r.connection !== c || m.e !== c.epoch) return;
    const endpoint = r.session.endpoint;
    if (endpoint.receiveControl(m)) return;
    if (m.t === 'ping' && isUint(m.n)) { endpoint.sendControl({ t: 'pong', e: c.epoch, n: m.n, s: performance.now() }); return; }
    if (m.t === 'leave') { this.expire(r); return; }
    if (m.t === 'rtc-reset' && m.a === c.attempt) { this.stopRtc(c, false); return; }
    if (m.t === 'signal' && isUint(m.a) && m.a > 0 && validSignal(m.d)) {
      if (!this.options.rtc) { endpoint.sendControl({ t: 'rtc-reset', e: c.epoch, a: m.a }); return; }
      if (m.d.kind === 'offer') {
        if (m.a <= c.attempt || performance.now() - c.rtcStarted < 1000 && c.attempt > 0) return;
        this.stopRtc(c, false); c.attempt = m.a; c.rtcStarted = performance.now();
        const a = c.attempt, epoch = c.epoch;
        const current = () => r.connection === c && c.attempt === a && c.epoch === epoch && this.connections.has(c);
        c.rtc = this.options.rtc({
          signal: d => { if (current()) endpoint.sendControl({ t: 'signal', e: epoch, a, d }); },
          open: link => { if (current()) endpoint.attachDatagram(link); else link.close(); },
          data: data => {
            if (!current()) return;
            const now = performance.now();
            if (!c.messages.take(1, now) || !c.bytes.take(data.length, now)) { this.stats.rateLimited++; c.ws.close(1008, 'rate'); return; }
            try { endpoint.receiveBinary(data, 'rtc'); } catch (error) { this.report(error); c.ws.close(1002, 'protocol'); }
          },
          closed: () => { if (current()) this.stopRtc(c, true); },
          error: e => { if (current()) { this.report(e); this.stopRtc(c, true); } },
        });
      }
      if (m.a === c.attempt) {
        try {
          const pending = c.rtc?.signal(m.d);
          if (pending) void pending.catch(error => { this.report(error); this.stopRtc(c, true); });
        } catch (error) { this.report(error); this.stopRtc(c, true); }
      }
    }
  }
  private stopRtc(c: Connection, notify: boolean): void {
    const rtc = c.rtc; c.rtc = undefined;
    if (notify && rtc) c.record?.session.endpoint.sendControl({ t: 'rtc-reset', e: c.epoch, a: c.attempt });
    if (c.record?.connection === c) c.record.session.endpoint.dropDatagram(false);
    rtc?.close();
  }
  private disconnect(c: Connection): void {
    this.connections.delete(c); this.stopRtc(c, false);
    const r = c.record;
    if (!r || r.connection !== c) return;
    r.connection = undefined; r.session.connected = false; r.session.disconnectedAt = performance.now();
    r.session.endpoint.detach();
    this.emit('disconnect', r.session);
  }
  private expire(r: SessionRecord): void {
    if (!this.tokens.has(r.token)) return;
    this.tokens.delete(r.token); this.sessions.delete(r.session.id); this.stats.expiredSessions++;
    const c = r.connection;
    if (c) { this.stopRtc(c, false); c.record = undefined; c.ws.close(1000, 'left'); }
    r.connection = undefined; r.session.connected = false; r.session.endpoint.detach();
    this.emit('expire', r.session);
  }
  /** End a session now (kick). The client reports session loss and does not reconnect into it. */
  endSession(session: GameSession, reason = 'removed'): void {
    for (const r of this.tokens.values()) if (r.session === session) {
      const c = r.connection;
      if (c?.ws.readyState === 1) try { c.ws.send(stringify({ t: 'reset', reason: reason.slice(0, 100) })); } catch { /* closing anyway */ }
      this.expire(r); return;
    }
  }
  private pump(): void {
    const now = performance.now();
    for (const c of this.connections) {
      if (!c.record && now - c.started > (this.options.handshakeTimeoutMs ?? 5000) ||
          c.record && now - c.lastSeen > (this.options.heartbeatTimeoutMs ?? 15000)) { c.ws.terminate(); continue; }
      if (c.rtc && now - c.rtcStarted > 10000 && !c.record?.session.endpoint.fastActive) this.stopRtc(c, true);
    }
    const sessions = [...this.sessions.values()];
    const start = this.pumpCursor++ % Math.max(1, sessions.length);
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[(start + i) % sessions.length]!;
      try { if (s.connected) s.endpoint.pump(); } catch (e) { this.report(e); }
    }
    for (const r of [...this.tokens.values()]) if (!r.session.connected && now - r.session.disconnectedAt > (this.options.resumeGraceMs ?? 90000)) this.expire(r);
  }
  /** Broadcast reliable events to every session that joined with this hello room. For snapshots, filter per session. */
  broadcast(room: string, data: JsonInput): { queued: number; rejected: string[] } {
    const result = { queued: 0, rejected: [] as string[] };
    for (const s of this.sessions.values()) if (s.room === room) {
      try { s.sendEvent(data); result.queued++; }
      catch (error) { result.rejected.push(s.id); this.report(error); }
    }
    return result;
  }
  /** Totals for a health endpoint: sessions, connections, transports and traffic. */
  metrics() {
    let rtc = 0, ws = 0, bytesSent = 0, bytesReceived = 0, pendingEvents = 0;
    for (const s of this.sessions.values()) {
      const t = s.transport; if (t === 'rtc') rtc++; else if (t === 'ws') ws++;
      bytesSent += s.endpoint.stats.bytesSent; bytesReceived += s.endpoint.stats.bytesReceived; pendingEvents += s.endpoint.events.size;
    }
    return { sessions: this.sessions.size, connections: this.connections.size, rtc, ws, bytesSent, bytesReceived, pendingEvents, ...this.stats };
  }
  async close(): Promise<void> {
    this.shuttingDown = true; clearInterval(this.timer); this.timer = undefined;
    for (const c of this.connections) { this.stopRtc(c, false); c.ws.terminate(); }
    this.wsServer.close();
    await new Promise<void>(resolve => this.httpServer.close(() => resolve()));
    this.connections.clear(); this.tokens.clear(); this.sessions.clear();
  }
}
export async function createGameServer(options: GameServerOptions): Promise<GameServer> {
  const name = 'ws'; const module = await import(name) as unknown as WsModule;
  return new GameServer(options, module);
}
