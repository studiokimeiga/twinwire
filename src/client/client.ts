import { Endpoint, type EndpointOptions, type Impairment, type StateMessage, type StateOptions } from '../core/endpoint.js';
import { type ReliableCheckpoint } from '../core/reliable.js';
import { isUint, readControl, stringify, utf8Length, VERSION, type Json, type JsonInput } from '../core/protocol.js';
import { validIceServers, validSignal, type IceServer } from '../core/rtc.js';
import { NetworkClock } from '../netcode/clock.js';
import { BrowserRtcPeer } from './rtc.js';
import { StateReceiver, type StateReceiverOptions } from './state.js';
export type ClientStatus = 'idle' | 'connecting' | 'online' | 'paused' | 'closed' | 'lost';
export type Transport = 'rtc' | 'ws' | 'none';
export interface ClientCheckpoint { url: string; room: string; token: string; id: string; events: ReliableCheckpoint }
export interface LifecycleOptions {
  /** Pause after the page has been hidden this long (default 20 s). A page kept in the back/forward cache pauses at once. */
  hiddenPauseMs?: number;
  /** After the page comes back, a socket that stays silent this long is replaced (default 1500 ms). */
  wakeCheckMs?: number;
  /** When the page really unloads (closed, reloaded, navigated away): 'pause' keeps the session (and lobby seat) for
   * a checkpointed reload to resume; 'leave' ends it at once, so nobody waits out the resume grace for a player who
   * won't come back. 'auto' (default): 'pause' if this client started from a checkpoint or checkpoint() was called,
   * else 'leave'. Games that checkpoint in their own pagehide handler should say 'pause'. */
  unload?: 'auto' | 'pause' | 'leave';
}
export interface ClientOptions {
  url: string; room: string; auth?: Json;
  /** false: WebSocket only. An RTCConfiguration with iceServers overrides the servers the room server suggests. */
  rtc?: false | RTCConfiguration;
  endpoint?: EndpointOptions; websocket?: (url: string) => WebSocket;
  reconnectBaseMs?: number; reconnectMaxMs?: number; heartbeatTimeoutMs?: number;
  rtcRetryMs?: number; rtcConnectTimeoutMs?: number; pumpHz?: number; checkpoint?: ClientCheckpoint;
  /** Clock sync: `syncPings` pings `syncPingMs` apart after each connect (8, 250), then one every `pingMs` (1000). */
  syncPings?: number; syncPingMs?: number; pingMs?: number;
  /** Simulated trouble on this client's sends; also asked of the server (honoured only with allowImpairment). */
  impair?: Impairment;
}
export class GameClient {
  endpoint: Endpoint;
  readonly clock = new NetworkClock();
  status: ClientStatus = 'idle';
  id: string | null = null;
  /** ICE servers suggested by the room server (STUN/TURN), used unless options.rtc names its own. */
  iceServers: IceServer[] = [];
  onStatus: (status: ClientStatus) => void = () => {};
  onSession: (info: { id: string; resumed: boolean }) => void = () => {};
  onSessionLost: (info: { pendingEvents: number; reason: string }) => void = () => {};
  onState: (state: StateMessage) => void = () => {};
  onEvent: (data: Json, seq: number) => void = () => {};
  onStateAck: (stream: number, seq: number) => void = () => {};
  onTransport: (transport: Transport) => void = () => {};
  onError: (error: Error) => void = () => {};
  private token: string | null = null;
  private socket?: WebSocket;
  private checkpointed = false;
  private burstLeft = 0;
  private generation = 0;
  private epoch = 0;
  private peer?: BrowserRtcPeer;
  private rtcAttempt = 0;
  private rtcStartedAt = 0;
  private rtcRetryAt = Infinity;
  private rtcFailures = 0;
  private reconnects = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private pumpTimer?: ReturnType<typeof setInterval>;
  private lastPump = 0;
  private lastPing = -Infinity;
  private lastMessage = 0;
  private closingDeadline = Infinity;
  private openedAt = 0;
  private wakeDeadline = Infinity;
  private pendingPings = new Map<number, number>();
  private pingId = 0;
  private stopped = true;
  private serverRtc = false;
  private lastTransport: Transport = 'none';
  private waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private lifecycle?: () => void;
  private interceptors: ((data: Json, seq: number) => boolean)[] = [];
  private stateReceivers = new Map<number | undefined, StateReceiver>();
  private listeners: { session: ((info: { id: string; resumed: boolean }) => void)[]; lost: ((info: { pendingEvents: number; reason: string }) => void)[] } = { session: [], lost: [] };
  constructor(readonly options: ClientOptions) {
    const u = new URL(options.url);
    if (!['ws:', 'wss:'].includes(u.protocol) || !/^[\w:.-]{1,64}$/.test(options.room)) throw new Error('Invalid URL or room');
    this.endpoint = this.makeEndpoint();
    const cp = options.checkpoint;
    if (cp) {
      if (cp.url !== options.url || cp.room !== options.room || !/^[\w-]{20,128}$/.test(cp.token) || typeof cp.id !== 'string')
        throw new Error('Checkpoint belongs to a different endpoint or is invalid');
      this.endpoint.events.restore(cp.events); this.token = cp.token; this.id = cp.id; this.checkpointed = true;
    }
  }
  private makeEndpoint(): Endpoint {
    const e = new Endpoint({ ...this.options.endpoint, impair: this.options.impair ?? this.options.endpoint?.impair });
    e.onState = s => {
      const receiver = this.stateReceivers.get(s.stream);
      if (receiver) try { receiver.receive(s); } catch (error) { this.report(error); }
      const grouped = this.stateReceivers.get(undefined);
      if (grouped) try { grouped.receive(s); } catch (error) { this.report(error); }
      this.onState(s);
    };
    e.onEvent = (d, s) => { for (const f of this.interceptors) if (f(d, s)) return; this.onEvent(d, s); };
    e.onStateAck = (stream, seq) => this.onStateAck(stream, seq);
    e.onCallbackError = error => this.report(error);
    e.onFastDown = () => this.stopRtc(true);
    e.onFastChange = () => this.noteTransport();
    return e;
  }
  /** Consume some events before onEvent sees them (return true to consume). Used by LobbyClient. Returns removal. */
  intercept(fn: (data: Json, seq: number) => boolean): () => void {
    this.interceptors.push(fn); return () => { const i = this.interceptors.indexOf(fn); if (i >= 0) this.interceptors.splice(i, 1); };
  }
  /** Own recovery for an authoritative snapshot stream. Decode/apply only usable state; let the receiver hold
   * playback until fresh data arrives. One receiver per stream plus one filtered receiver for grouped streams,
   * bounded by endpoint.maxStreams (default 1024).
   * onState remains an observer of all incoming states. Dispose the receiver when its room/world is discarded. */
  receiveState(options: StateReceiverOptions): StateReceiver {
    const stream = options.stream;
    if (this.stateReceivers.has(stream)) throw new Error('Snapshot stream already has a receiver');
    if (this.stateReceivers.size >= (this.options.endpoint?.maxStreams ?? 1024)) throw new RangeError('Too many state receivers');
    const receiver = new StateReceiver({
      connected: () => this.status === 'online' && this.endpoint.active, generation: () => this.generation,
      now: () => this.clock.synced ? this.clock.serverTime(performance.now()) : null,
      tolerance: () => Math.max(1, this.clock.uncertaintyMs),
      remove: () => { if (this.stateReceivers.get(stream) === receiver) this.stateReceivers.delete(stream); },
    }, options);
    this.stateReceivers.set(stream, receiver);
    if (this.status === 'online') try { receiver.session(false); } catch (error) { this.report(error); }
    return receiver;
  }
  /** Extra listeners next to onSession/onSessionLost. Returns removal. */
  on<K extends 'session' | 'lost'>(kind: K, fn: GameClient['listeners'][K][number]): () => void {
    const list = this.listeners[kind] as unknown[]; list.push(fn);
    return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
  }
  private lost(info: { pendingEvents: number; reason: string }) {
    for (const f of this.listeners.lost) try { f(info); } catch (e) { this.report(e); }
    this.onSessionLost(info);
  }
  /** Which path state messages take right now. */
  get transport(): Transport { return this.status !== 'online' ? 'none' : this.endpoint.fastActive ? 'rtc' : 'ws'; }
  private noteTransport() {
    const t = this.transport;
    if (t === 'rtc') this.rtcFailures = 0; // bidirectional proof recovered: the next outage starts at the base retry
    if (t !== this.lastTransport) { this.lastTransport = t; try { this.onTransport(t); } catch (e) { this.report(e); } }
  }
  private report(error: unknown) { this.onError(error instanceof Error ? error : new Error(String(error))); }
  private setStatus(s: ClientStatus) {
    if (s === this.status) return;
    if (s !== 'online') for (const receiver of this.stateReceivers.values()) receiver.disconnect();
    this.status = s; this.onStatus(s); this.noteTransport();
    if (s === 'online') for (const w of this.waiters.splice(0)) w.resolve();
    else if (s === 'lost' || s === 'closed') for (const w of this.waiters.splice(0)) w.reject(new Error(`Session ${s}`));
  }
  /** Resolves when the session is online (at once if it already is); rejects if it is lost or closed first. */
  whenOnline(): Promise<void> {
    if (this.status === 'online') return Promise.resolve();
    if (this.status === 'lost' || this.status === 'closed') return Promise.reject(new Error(`Session ${this.status}`));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  connect(): void {
    if (this.status === 'online' || this.status === 'connecting') return;
    if (this.status === 'lost') throw new Error('Call newSession() after session expiry');
    this.stopped = false; this.setStatus('connecting');
    clearInterval(this.pumpTimer); this.lastPump = performance.now();
    this.pumpTimer = setInterval(() => this.pump(), 1000 / (this.options.pumpHz ?? 60));
    this.open();
  }
  private open(): void {
    if (this.stopped) return;
    clearTimeout(this.retryTimer); this.retryTimer = undefined;
    const generation = ++this.generation;
    const now = performance.now(); this.openedAt = this.lastMessage = now; this.closingDeadline = Infinity;
    let ws: WebSocket;
    try { ws = (this.options.websocket ?? (u => new WebSocket(u)))(this.options.url); }
    catch (error) { this.report(error); this.retry(); return; }
    this.socket = ws; ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      if (generation !== this.generation || this.stopped) { ws.close(); return; }
      ws.send(stringify({ t: 'hello', v: VERSION, room: this.options.room, token: this.token, auth: this.options.auth ?? null,
        impair: (this.options.impair ?? null) as Json }));
    };
    ws.onmessage = ev => {
      if (generation !== this.generation || this.stopped || ws.readyState !== 1) return;
      this.lastMessage = performance.now(); this.wakeDeadline = Infinity;
      try {
        if (ev.data instanceof ArrayBuffer) this.endpoint.receiveBinary(new Uint8Array(ev.data), 'ws');
        else if (typeof ev.data === 'string') this.message(ev.data, ws);
      } catch (error) { this.report(error); ws.close(4004, 'protocol'); }
    };
    ws.onerror = () => {}; // close/retry is the single failure path
    ws.onclose = ev => {
      if (generation !== this.generation) return;
      // (the clock is kept: a resumed session talks to the same server process, so the same clock; see the welcome)
      this.socket = undefined; this.endpoint.detach(); this.stopRtc(false); this.pendingPings.clear();
      if (!this.stopped) {
        if ([1002, 1008, 4001, 4002, 4004].includes(ev.code)) {
          this.stopped = true; clearInterval(this.pumpTimer); clearTimeout(this.retryTimer); this.setStatus('lost');
          this.lost({ pendingEvents: this.endpoint.events.size, reason: ev.reason || `connection rejected (${ev.code})` });
        } else { this.setStatus('connecting'); this.retry(); }
      }
    };
  }
  private message(raw: string, ws: WebSocket): void {
    this.endpoint.stats.bytesReceived += utf8Length(raw);
    const m = readControl(raw); if (!m) throw new Error('Invalid control message');
    if (m.t === 'reset') {
      this.stopped = true; clearInterval(this.pumpTimer); clearTimeout(this.retryTimer);
      this.stopRtc(false); this.endpoint.detach(); ws.close(); this.setStatus('lost');
      this.lost({ pendingEvents: this.endpoint.events.size, reason: typeof m.reason === 'string' ? m.reason : 'expired' }); return;
    }
    if (m.t === 'welcome') {
      if (this.status !== 'connecting' || !isUint(m.e, 0xffff) || !m.e || typeof m.b !== 'number' || !Number.isFinite(m.b) || typeof m.id !== 'string' ||
          typeof m.token !== 'string' || !/^[\w-]{20,128}$/.test(m.token) || typeof m.resumed !== 'boolean' || m.v !== VERSION)
        throw new Error('Invalid welcome');
      const generation = this.generation;
      this.token = m.token; this.id = m.id; this.epoch = m.e; this.reconnects = 0; this.serverRtc = m.rtc === true;
      this.iceServers = validIceServers(m.ice) ? m.ice : [];
      this.endpoint.attach(this.epoch, {
        get open() { return ws.readyState === 1; }, get bufferedAmount() { return ws.bufferedAmount; },
        send(data) { if (ws.readyState !== 1) return false; ws.send(typeof data === 'string' ? data : data.slice().buffer); return true; },
        close() { ws.close(); },
      }, m.b);
      // a new session may be a new server (restarted, so a new clock): start the estimate over; a resumed one keeps it.
      // Either way a burst of pings, for whatever the network is now.
      if (!m.resumed) this.clock.reset();
      for (const receiver of this.stateReceivers.values()) try { receiver.session(m.resumed); } catch (error) { this.report(error); }
      if (this.stopped || this.generation !== generation) return; // a reset callback may leave or start a new session
      this.lastPing = -Infinity; this.burstLeft = this.options.syncPings ?? 8; this.setStatus('online');
      const info = { id: this.id, resumed: m.resumed };
      for (const f of this.listeners.session) try { f(info); } catch (e) { this.report(e); }
      this.onSession(info); this.rtcFailures = 0; this.rtcRetryAt = performance.now();
      this.pump(); return;
    }
    if (m.e !== this.epoch || this.status !== 'online') return;
    if (this.endpoint.receiveControl(m)) return;
    if (m.t === 'pong' && isUint(m.n) && typeof m.s === 'number' && Number.isFinite(m.s)) {
      const at = this.pendingPings.get(m.n); if (at === undefined) return;
      this.pendingPings.delete(m.n); this.clock.observe(at, performance.now(), m.s); return;
    }
    if (m.t === 'signal' && m.a === this.rtcAttempt && validSignal(m.d)) { void this.peer?.signal(m.d); return; }
    if (m.t === 'rtc-reset' && m.a === this.rtcAttempt && this.peer) this.stopRtc(false);
  }
  /** Retire locally before close(): browsers can wait indefinitely for an offline close handshake. */
  private replaceSocket(reason: string): void {
    const socket = this.socket, generation = ++this.generation;
    this.socket = undefined; this.endpoint.detach(); this.stopRtc(false); this.pendingPings.clear();
    this.closingDeadline = this.wakeDeadline = Infinity;
    try { socket?.close(4000, reason); } catch { /* the old socket is already fenced */ }
    this.setStatus('connecting');
    if (generation === this.generation) this.retry();
  }
  private retry(): void {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    const cap = Math.min(this.options.reconnectMaxMs ?? 8000, (this.options.reconnectBaseMs ?? 200) * 2 ** Math.min(this.reconnects++, 8));
    this.retryTimer = setTimeout(() => this.open(), cap * (0.5 + Math.random() / 2));
  }
  /** Testing: drop the connection as a network failure would (the session resumes by itself). */
  simulateDrop(): void { this.socket?.close(4000, "simulated drop"); }
  /** Skip the backoff wait (the network just came back, the page woke up). */
  reconnectNow(): void {
    if (this.stopped || this.status === 'online') return;
    this.reconnects = 0;
    if (this.retryTimer !== undefined || !this.socket) this.open();
  }
  private rtcConfig(): RTCConfiguration {
    const own = this.options.rtc || undefined;
    return own?.iceServers ? own : { ...own, iceServers: this.iceServers as RTCIceServer[] };
  }
  private startRtc(): void {
    if (!this.serverRtc || this.peer || this.options.rtc === false || typeof RTCPeerConnection === 'undefined' || this.status !== 'online') return;
    const a = ++this.rtcAttempt, e = this.epoch; this.rtcStartedAt = performance.now(); this.rtcRetryAt = Infinity;
    try {
      const peer = new BrowserRtcPeer({
        signal: d => { if (a === this.rtcAttempt && e === this.epoch) this.endpoint.sendControl({ t: 'signal', e, a, d }); },
        open: link => { if (a === this.rtcAttempt && e === this.epoch && !this.stopped) this.endpoint.attachDatagram(link); else link.close(); },
        data: data => { if (a === this.rtcAttempt && e === this.epoch) this.endpoint.receiveBinary(data, 'rtc'); },
        closed: () => { if (a === this.rtcAttempt && e === this.epoch) this.stopRtc(true); },
        error: error => { if (a === this.rtcAttempt && e === this.epoch) { this.report(error); this.stopRtc(true); } },
      }, this.rtcConfig());
      this.peer = peer;
      void peer.offer().catch(error => { if (this.peer === peer) { this.report(error); this.stopRtc(true); } });
    } catch (error) { this.report(error); this.stopRtc(true); }
  }
  private stopRtc(notify: boolean): void {
    const a = this.rtcAttempt, peer = this.peer; this.peer = undefined;
    if (notify && peer) this.endpoint.sendControl({ t: 'rtc-reset', e: this.epoch, a });
    this.endpoint.dropDatagram(false); peer?.close();
    this.rtcRetryAt = performance.now() + Math.min(60000, (this.options.rtcRetryMs ?? 3000) * 2 ** Math.min(this.rtcFailures++, 4));
    this.noteTransport();
  }
  private pump(): void {
    if (this.stopped) return;
    const now = performance.now(); this.clock.advance(Math.max(0, now - this.lastPump)); this.lastPump = now;
    if (this.status === 'online') {
      if (now - this.lastMessage > (this.options.heartbeatTimeoutMs ?? 8000) || now > this.wakeDeadline) {
        this.replaceSocket('heartbeat timeout'); return;
      }
      if (this.socket && this.socket.readyState !== 1) {
        // Announce the interruption immediately, but allow a normal terminal close event to report its reason.
        this.endpoint.detach(); this.stopRtc(false); this.pendingPings.clear();
        this.closingDeadline = now + Math.min(1000, this.options.heartbeatTimeoutMs ?? 8000);
        this.setStatus('connecting'); return;
      }
      // a burst of pings after each connect so the clock settles in about two seconds, then one a second
      const o = this.options, burst = this.burstLeft > 0 && this.pendingPings.size < 8;
      if (now - this.lastPing >= (burst ? o.syncPingMs ?? 250 : o.pingMs ?? 1000)) { this.ping(now); if (burst) this.burstLeft--; }
      if (this.peer && now - this.rtcStartedAt > (this.options.rtcConnectTimeoutMs ?? 8000) && !this.endpoint.fastActive) this.stopRtc(true);
      if (!this.peer && now >= this.rtcRetryAt) this.startRtc();
      this.endpoint.pump();
      this.noteTransport();
    } else if (this.socket && (now >= this.closingDeadline || now - this.openedAt > 10000)) { this.replaceSocket('handshake timeout'); }
  }
  private ping(now: number) {
    const n = this.pingId = (this.pingId + 1) >>> 0;
    if (this.endpoint.sendControl({ t: 'ping', e: this.epoch, n })) { this.pendingPings.set(n, now); this.lastPing = now; }
    for (const [id, at] of this.pendingPings) if (now - at > 10000) this.pendingPings.delete(id);
  }
  sendEvent(data: JsonInput): number { return this.endpoint.sendEvent(data); }
  /** Queue the newest state for a stream. Returns its seq, or 0 before the session is online and the clock synced. */
  sendState(stream: number, data: Uint8Array, options?: StateOptions): number {
    if (!this.clock.synced) return 0;
    return this.endpoint.sendState(stream, data, this.clock.serverTime(performance.now()), options);
  }
  flush(): void { this.endpoint.flush(); }
  /** Stop the physical connection, retaining event counters and resume credentials in this instance. */
  pause(): void {
    this.stopped = true; ++this.generation; clearTimeout(this.retryTimer); clearInterval(this.pumpTimer);
    this.stopRtc(false); this.endpoint.detach(); this.socket?.close(4003, 'paused'); this.socket = undefined; this.setStatus('paused');
  }
  resume(): void { if (this.status === 'paused') this.connect(); }
  /** Explicitly discard the old logical session after expiry. Pending actions are NOT replayed into a new session. */
  newSession(): void {
    this.pause(); this.endpoint = this.makeEndpoint(); this.token = this.id = null; this.epoch = 0; this.connect();
  }
  close(): void {
    if (this.status === 'closed') return;
    try { this.endpoint.sendControl({ t: 'leave', e: this.epoch }); } catch { /* best effort */ }
    this.pause(); this.lifecycle?.(); this.lifecycle = undefined; this.setStatus('closed');
  }
  checkpoint(): ClientCheckpoint | null {
    this.checkpointed = true;
    return this.token && this.id ? { url: this.options.url, room: this.options.room, token: this.token, id: this.id, events: this.endpoint.events.checkpoint() } : null;
  }
  /** Opt-in page lifecycle integration: pause when the page goes away or stays hidden, reconnect fast when it is back,
   * and replace a socket that died while the phone slept. Returns cleanup. */
  bindPageLifecycle(o: LifecycleOptions = {}): () => void {
    this.lifecycle?.();
    const hiddenPause = o.hiddenPauseMs ?? 20000, wakeCheck = o.wakeCheckMs ?? 1500;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const pauseNow = () => { clearTimeout(hideTimer); if (this.status === 'online' || this.status === 'connecting') this.pause(); };
    const back = () => {
      clearTimeout(hideTimer);
      if (this.status === 'paused') { this.resume(); return; }
      if (this.status === 'online') { this.wakeDeadline = performance.now() + wakeCheck; this.ping(performance.now()); }
      else this.reconnectNow();
    };
    const visible = () => {
      if (document.visibilityState === 'visible') back();
      else { clearTimeout(hideTimer); hideTimer = setTimeout(pauseNow, hiddenPause); }
    };
    const unload = o.unload ?? 'auto';
    const pagehide = (e: Event) => {
      // kept in the back/forward cache, or a reload that will resume: pause; a page that is gone: leave
      const keep = (e as PageTransitionEvent).persisted || unload === 'pause' || (unload === 'auto' && this.checkpointed);
      if (keep) pauseNow(); else { clearTimeout(hideTimer); this.close(); }
    };
    const pageshow = () => back(), online = () => this.reconnectNow();
    window.addEventListener('pagehide', pagehide); window.addEventListener('pageshow', pageshow);
    window.addEventListener('online', online); document.addEventListener('visibilitychange', visible);
    const off = () => {
      clearTimeout(hideTimer);
      window.removeEventListener('pagehide', pagehide); window.removeEventListener('pageshow', pageshow);
      window.removeEventListener('online', online); document.removeEventListener('visibilitychange', visible);
    };
    this.lifecycle = off; return off;
  }
}
