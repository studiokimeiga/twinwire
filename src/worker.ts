/** Standard-WebSocket host for a long-lived Worker/Durable Object instance.
 * No Node, native RTC, storage or hibernation dependencies. The application owns upgrades and durable worlds. */
import { GameSession } from './core/session.js';
import { TokenBucket } from './core/budget.js';
import { readControl, isUint, VERSION, MAX_CONTROL_BYTES, type Json } from './core/protocol.js';
import type { EndpointOptions } from './core/endpoint.js';
export { GameSession } from './core/session.js';
export interface SessionSocket {
  readonly readyState: number; readonly bufferedAmount?: number; binaryType?: string;
  send(data: string | Uint8Array): void; close(code?: number, reason?: string): void;
  addEventListener(type: 'message', callback: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error', callback: () => void): void;
}
export interface SocketSessionOptions {
  origins: string[] | ((origin: string) => boolean); allowMissingOrigin?: boolean;
  endpoint?: EndpointOptions; resumeGraceMs?: number; heartbeatTimeoutMs?: number; handshakeTimeoutMs?: number;
  maxSessions?: number; maxConnections?: number; maxPerIp?: number; maxSessionsPerIp?: number; pumpHz?: number;
  rateLimit?: { messages?: number; bytes?: number };
  authenticate?: (request: { room: string; auth: Json; resuming: boolean; ip: string }) => string | null | Promise<string | null>;
  onSession?: (session: GameSession, resumed: boolean) => void;
  onDisconnect?: (session: GameSession) => void; onExpire?: (session: GameSession) => void;
  onError?: (error: Error) => void;
}
interface RecordEntry { session: GameSession; token: string; connection?: Connection }
interface Connection {
  socket: SessionSocket; ip: string; epoch: number; started: number; lastSeen: number;
  authenticating: boolean; record?: RecordEntry; messages: TokenBucket; bytes: TokenBucket;
}
const encoder = new TextEncoder();
const token = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export class SocketSessionServer {
  readonly sessions = new Map<string, GameSession>();
  readonly stats = { sessionResumes: 0, expiredSessions: 0, protocolErrors: 0, rateLimited: 0 };
  private records = new Map<string, RecordEntry>();
  private connections = new Set<Connection>();
  private epoch = crypto.getRandomValues(new Uint16Array(1))[0] || 1;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(readonly options: SocketSessionOptions) {
    if (typeof options.origins !== 'function' && (!Array.isArray(options.origins) || options.origins.some(o => typeof o !== 'string' || o === '*')))
      throw new TypeError('Supply exact permitted origins');
    if (options.pumpHz !== undefined && !(options.pumpHz >= 10 && options.pumpHz <= 250)) throw new RangeError('pumpHz must be 10 to 250');
  }
  allowsOrigin(origin: string): boolean {
    if (!origin) return !!this.options.allowMissingOrigin;
    return typeof this.options.origins === 'function' ? this.options.origins(origin) : this.options.origins.includes(origin);
  }
  /** Pass an already accepted standard WebSocket. Reject disallowed upgrade requests before accepting them when possible. */
  accept(socket: SessionSocket, context: { origin: string; ip: string }): void {
    if (this.stopped || !this.allowsOrigin(context.origin)) { socket.close(1008, 'origin'); return; }
    const mine = [...this.connections].filter(c => c.ip === context.ip).length;
    if (this.connections.size >= (this.options.maxConnections ?? 512) || mine >= (this.options.maxPerIp ?? 32)) {
      socket.close(1013, 'capacity'); return;
    }
    // Workers now default binary frames to Blob. Select synchronous delivery before installing the listener.
    socket.binaryType = 'arraybuffer';
    const now = performance.now();
    const c: Connection = { socket, ip: context.ip, epoch: 0, started: now, lastSeen: now, authenticating: false,
      messages: new TokenBucket(this.options.rateLimit?.messages ?? 300, this.options.rateLimit?.messages ?? 300, now),
      bytes: new TokenBucket(this.options.rateLimit?.bytes ?? 256 * 1024, this.options.rateLimit?.bytes ?? 256 * 1024, now) };
    this.connections.add(c);
    socket.addEventListener('message', event => this.receive(c, event.data));
    socket.addEventListener('close', () => {
      this.disconnect(c);
      // Older Worker compatibility dates require an explicit reply to the peer's close frame.
      if (socket.readyState === 2) try { socket.close(); } catch { /* already closed */ }
    });
    socket.addEventListener('error', () => { this.disconnect(c); socket.close(1011, 'connection error'); });
    this.timer ??= setInterval(() => this.pump(), 1000 / (this.options.pumpHz ?? 60));
  }
  private report(error: unknown): void {
    try { this.options.onError?.(error instanceof Error ? error : new Error(String(error))); } catch { /* diagnostics cannot break the pump */ }
  }
  private receive(c: Connection, data: unknown): void {
    if (!this.connections.has(c) || c.epoch && !c.record || c.record && c.record.connection !== c) return;
    const bytes = typeof data === 'string' ? encoder.encode(data) : data instanceof ArrayBuffer ? new Uint8Array(data) :
      ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (!bytes) { c.socket.close(1002, 'protocol'); return; }
    const now = performance.now(); c.lastSeen = now;
    if (!c.messages.take(1, now) || !c.bytes.take(bytes.byteLength, now)) { this.stats.rateLimited++; c.socket.close(1008, 'rate'); return; }
    try {
      if (typeof data !== 'string') {
        if (!c.record || bytes.length > c.record.session.endpoint.maxFrameBytes) throw new Error('Unexpected binary frame');
        c.record.session.endpoint.receiveBinary(bytes, 'ws'); return;
      }
      if (bytes.length > MAX_CONTROL_BYTES) throw new Error('Oversized control');
      const message = readControl(data); if (!message) throw new Error('Invalid control');
      if (message.t === 'hello') { void this.hello(c, message).catch(error => { this.report(error); c.socket.close(1008, 'join'); }); return; }
      const r = c.record; if (!r || message.e !== c.epoch) return;
      r.session.endpoint.stats.bytesReceived += bytes.length;
      if (r.session.endpoint.receiveControl(message)) return;
      if (message.t === 'ping' && isUint(message.n)) r.session.endpoint.sendControl({t:'pong',e:c.epoch,n:message.n,s:performance.now()});
      else if (message.t === 'leave') this.expire(r);
      else if (message.t === 'signal' && isUint(message.a)) r.session.endpoint.sendControl({t:'rtc-reset',e:c.epoch,a:message.a});
    } catch (error) { this.stats.protocolErrors++; this.report(error); c.socket.close(1002, 'protocol'); }
  }
  private async hello(c: Connection, message: Record<string, unknown>): Promise<void> {
    if (c.record || c.authenticating || message.v !== VERSION || typeof message.room !== 'string' || !/^[\w:.-]{1,64}$/.test(message.room) ||
      !(message.token === null || typeof message.token === 'string' && /^[\w-]{20,128}$/.test(message.token))) throw new Error('Invalid hello');
    c.authenticating = true;
    const auth = (message.auth ?? null) as Json, resumed = typeof message.token === 'string';
    const subject = this.options.authenticate ? await this.options.authenticate({room:message.room,auth,resuming:resumed,ip:c.ip}) : null;
    if (!this.connections.has(c) || c.socket.readyState !== 1 || this.stopped) return;
    if (this.options.authenticate && (typeof subject !== 'string' || !subject)) throw new Error('Authentication rejected');
    let record: RecordEntry | undefined;
    if (resumed) {
      record = this.records.get(message.token as string);
      if (!record || record.session.room !== message.room || record.session.subject !== subject ||
        !record.session.connected && performance.now() - record.session.disconnectedAt > (this.options.resumeGraceMs ?? 90_000)) {
        c.socket.send(JSON.stringify({t:'reset',reason:'session unavailable'})); c.socket.close(4001,'session unavailable'); return;
      }
      this.stats.sessionResumes++;
    } else {
      const mine = [...this.records.values()].filter(r => r.session.ip === c.ip);
      if (mine.length >= (this.options.maxSessionsPerIp ?? this.options.maxPerIp ?? 32)) {
        const idle = mine.filter(r => !r.session.connected).sort((a,b)=>a.session.disconnectedAt-b.session.disconnectedAt)[0];
        if (!idle) { c.socket.close(1013,'capacity'); return; } this.expire(idle);
      }
      if (this.sessions.size >= (this.options.maxSessions ?? 256)) { c.socket.close(1013,'capacity'); return; }
      const session = new GameSession(crypto.randomUUID(),message.room,subject,this.options.endpoint);
      session.endpoint.onCallbackError = error => this.report(error);
      record = {session,token:token()}; this.sessions.set(session.id,session); this.records.set(record.token,record);
    }
    const old = record.connection;
    if (old && old !== c) { old.record = undefined; old.socket.close(4002,'session resumed elsewhere'); }
    record.connection = c; c.record = record; c.authenticating = false;
    const s = record.session, socket = c.socket, base = performance.now();
    c.epoch = this.epoch = (this.epoch + 1) & 65535 || 1;
    s.epoch = c.epoch; s.connected = true; s.ip = c.ip; s.hello = auth;
    s.endpoint.attach(c.epoch,{
      get open(){return socket.readyState === 1;},get bufferedAmount(){return socket.bufferedAmount ?? 0;},
      send(data){if(socket.readyState!==1)return false;socket.send(data);return true;},close(){socket.close();},
    },base);
    s.endpoint.sendControl({t:'welcome',v:VERSION,e:c.epoch,b:base,id:s.id,token:record.token,resumed,rtc:false,ice:[]});
    try { this.options.onSession?.(s,resumed); } catch(error) { this.report(error); }
    s.endpoint.flush();
  }
  private disconnect(c: Connection): void {
    if (!this.connections.delete(c)) return;
    const record = c.record; c.record = undefined;
    if (!record || record.connection !== c) return;
    record.connection = undefined; record.session.connected = false;
    record.session.disconnectedAt = performance.now(); record.session.endpoint.detach();
    try { this.options.onDisconnect?.(record.session); } catch(error) { this.report(error); }
  }
  private expire(record: RecordEntry): void {
    if (!this.records.delete(record.token)) return;
    this.sessions.delete(record.session.id);
    const c = record.connection;
    if (c) { c.record = undefined; this.connections.delete(c); c.socket.close(1000,'left'); }
    record.session.connected = false; record.session.endpoint.detach();
    this.stats.expiredSessions++;
    try { this.options.onExpire?.(record.session); } catch(error) { this.report(error); }
  }
  endSession(session: GameSession, reason = 'removed'): void {
    for (const record of this.records.values()) if (record.session === session) {
      if (record.connection?.socket.readyState === 1) record.connection.socket.send(JSON.stringify({t:'reset',reason:reason.slice(0,100)}));
      this.expire(record); return;
    }
  }
  private pump(): void {
    const now = performance.now();
    for (const c of this.connections) {
      if (!c.record && now-c.started > (this.options.handshakeTimeoutMs ?? 10_000) ||
        now-c.lastSeen > (this.options.heartbeatTimeoutMs ?? 45_000)) { this.disconnect(c); c.socket.close(1000,'timeout'); }
      else if (c.record && now-c.started > 4*86400_000) { this.disconnect(c); c.socket.close(4000,'reconnect'); }
    }
    for (const record of this.records.values()) {
      const s=record.session;
      if (s.connected) s.endpoint.flush();
      else if (now-s.disconnectedAt > (this.options.resumeGraceMs ?? 90_000)) this.expire(record);
    }
    if (!this.connections.size && !this.records.size) { clearInterval(this.timer); this.timer=undefined; }
  }
  close(): void {
    this.stopped=true;clearInterval(this.timer);this.timer=undefined;
    for(const c of [...this.connections]){this.disconnect(c);c.socket.close(1000,'server closed');}
    this.records.clear();this.sessions.clear();
  }
}
