import { TokenBucket } from './budget.js';
import { EventRejected, ReliableEvents, type ReliableOptions } from './reliable.js';
import {
  decodeFrame, encodeFrame, FrameKind, DEFAULT_STATE_BYTES, HEADER_BYTES, MAX_STATE_BYTES, MTU_STATE_BYTES, newer, stringify,
  isUint, utf8, fromUtf8, utf8Length, type Frame, type Json, type JsonInput,
} from './protocol.js';
export interface ReliableLink {
  readonly open: boolean; readonly bufferedAmount: number;
  send(data: string | Uint8Array): boolean; close(): void;
}
export interface DatagramLink {
  readonly open: boolean; readonly bufferedAmount: number;
  send(data: Uint8Array): boolean; close(): void;
}
/** `late`: older than the newest state seen on its stream but not seen before (only with `lateStates: 'deliver'`). */
export interface StateMessage { stream: number; seq: number; time: number; data: Uint8Array; via: 'ws' | 'rtc'; late?: boolean }
/** Simulated network trouble on this endpoint's outgoing traffic (tests and tuning). lagMs is one way.
 * `loss` drops datagrams. On the WebSocket nothing is lost, but with `stallMs` a lost segment is retransmitted: with
 * probability `loss` a send (and everything queued behind it, in order) waits `stallMs` longer, as TCP's head-of-line
 * blocking does. Without `stallMs` the WebSocket is only delayed. */
export interface Impairment { lagMs?: number; jitterMs?: number; loss?: number; duplicate?: number; stallMs?: number }
export interface StateOptions { ttlMs?: number; priority?: number; ack?: boolean }
interface QueuedState { frame: Frame; deadline: number; first: number; priority: number }
export interface EndpointOptions {
  now?: () => number; bytesPerSecond?: number; burstBytes?: number; maxBufferedBytes?: number;
  maxStreams?: number; probeIntervalMs?: number; probeTimeoutMs?: number;
  /** Largest state payload accepted (default 64 KiB, at most 256 KiB). */
  maxStateBytes?: number;
  /** States larger than this use the WebSocket even when datagrams are up (default 8 KiB). */
  datagramStateBytes?: number;
  /** Mirror reliable events on the datagram path so they arrive at UDP latency (default true). */
  datagramEvents?: boolean;
  /** A state overtaken by a newer one on its stream: 'drop' it (default), or 'deliver' it once with `late: true` if it
   * is one of the last 32 and wasn't seen (for snapshots that feed an interpolation buffer). */
  lateStates?: 'drop' | 'deliver';
  /** How often state acknowledgements go back to the sender (default 50 ms). */
  stateAckIntervalMs?: number;
  events?: ReliableOptions;
  impair?: Impairment;
}
const DATAGRAM_EVENT_BYTES = 960;
export class Endpoint {
  readonly events: ReliableEvents;
  readonly stats = { bytesSent: 0, bytesReceived: 0, statesSent: 0, statesReceived: 0,
    stale: 0, expired: 0, coalesced: 0, congested: 0, invalid: 0, fastTransitions: 0, datagramRttMs: 0,
    eventsViaDatagram: 0, datagramEventFrames: 0, stateAcksSent: 0, stateAcksReceived: 0, impairedDrops: 0,
    impairedStalls: 0, eventsRejected: 0, callbackErrors: 0 };
  onState: (state: StateMessage) => void = () => {};
  /** A throw means "not accepted": the event is offered again (in order) shortly after, not dropped. */
  onEvent: (data: Json, seq: number) => void = () => {};
  /** An application callback threw (onEvent, onState, onStateAck). The connection carries on. */
  onCallbackError: (error: unknown) => void = () => {};
  private eventRetryAt = 0;
  onFastDown: () => void = () => {};
  onFastChange: (fast: boolean) => void = () => {};
  onEventAck: (seq: number) => void = () => {};
  /** The peer has seen state `seq` on `stream` (only for states sent with `ack: true`). */
  onStateAck: (stream: number, seq: number) => void = () => {};
  private reliable?: ReliableLink;
  private datagram?: DatagramLink;
  private epoch = 0;
  /** The connection's time base (from the welcome): frame times travel relative to it. */
  private timeBase = 0;
  private sequence = new Map<number, number>();
  private received = new Map<number, number>();
  /** Per stream: bit i set = the state i+1 before the newest was seen (late delivery only). */
  private seen = new Map<number, number>();
  private deliverLate: boolean;
  private queued = new Map<number, QueuedState>();
  private acksOut = new Map<number, number>();
  private acksIn = new Map<number, number>();
  private lastAckSentAt = -Infinity;
  private lastEventSent = 0;
  private datagramAcked = 0;
  private ackDue = false;
  private lastProbe = -Infinity;
  private proofAt = -Infinity;
  private attachedAt = 0;
  private probes = new Map<number, number>();
  private probeSeq = 0;
  private fast = false;
  readonly now: () => number;
  private budget: TokenBucket;
  private highWater: number;
  private maxStreams: number;
  private probeInterval: number;
  private probeTimeout: number;
  readonly maxStateBytes: number;
  private datagramStateBytes: number;
  private datagramEvents: boolean;
  private stateAckInterval: number;
  private impairment?: Impairment;
  constructor(o: EndpointOptions = {}) {
    this.now = o.now ?? (() => performance.now());
    const rate = o.bytesPerSecond ?? 32 * 1024;
    this.budget = new TokenBucket(rate, o.burstBytes ?? Math.max(rate / 2, 16 * 1024), this.now());
    this.highWater = o.maxBufferedBytes ?? 64 * 1024; this.maxStreams = o.maxStreams ?? 1024;
    this.probeInterval = o.probeIntervalMs ?? 250; this.probeTimeout = o.probeTimeoutMs ?? 1500;
    this.maxStateBytes = o.maxStateBytes ?? DEFAULT_STATE_BYTES;
    this.datagramStateBytes = o.datagramStateBytes ?? 8 * 1024;
    this.datagramEvents = o.datagramEvents ?? true; this.deliverLate = o.lateStates === 'deliver';
    this.stateAckInterval = o.stateAckIntervalMs ?? 50;
    this.events = new ReliableEvents(o.events);
    if (!(this.highWater > 0) || !isUint(this.maxStreams, 65536) || this.maxStreams < 1 ||
        !(this.probeInterval >= 10) || !(this.probeTimeout >= this.probeInterval * 2) ||
        !isUint(this.maxStateBytes, MAX_STATE_BYTES) || this.maxStateBytes < 1 ||
        !(this.datagramStateBytes >= MTU_STATE_BYTES) || !(this.stateAckInterval >= 0)) throw new RangeError('Invalid endpoint limits');
    if (o.impair) this.setImpairment(o.impair);
  }
  get active() { return !!this.reliable?.open; }
  get fastActive() { return this.fast && !!this.datagram?.open && this.now() - this.proofAt <= this.probeTimeout; }
  get pendingStates() { return this.queued.size; }
  get connectionEpoch() { return this.epoch; }
  get maxFrameBytes() { return this.maxStateBytes + HEADER_BYTES; }
  /** Newest seq the peer reported for an acknowledged stream in this connection epoch. */
  stateAck(stream: number): number | undefined { return this.acksIn.get(stream); }
  setImpairment(i: Impairment | null): void {
    if (!i) { this.impairment = undefined; return; }
    const { lagMs = 0, jitterMs = 0, loss = 0, duplicate = 0, stallMs = 0 } = i;
    if (![lagMs, jitterMs, stallMs].every(v => Number.isFinite(v) && v >= 0 && v <= 10000) ||
        ![loss, duplicate].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw new RangeError('Invalid impairment');
    this.impairment = lagMs || jitterMs || loss || duplicate ? { lagMs, jitterMs, loss, duplicate, stallMs } : undefined;
  }
  get impaired(): Impairment | undefined { return this.impairment && { ...this.impairment }; }
  attach(epoch: number, reliable: ReliableLink, timeBase = 0): void {
    if (!isUint(epoch, 0xffff) || !epoch || !Number.isFinite(timeBase)) throw new Error('Invalid epoch');
    this.detach(); this.epoch = epoch; this.timeBase = timeBase; this.reliable = this.impairReliable(reliable);
    this.ackDue = this.events.received > 0; this.lastEventSent = this.events.acknowledged; this.datagramAcked = 0;
    this.sequence.clear(); this.received.clear(); this.seen.clear(); this.acksOut.clear(); this.acksIn.clear();
    for (const e of this.events.entries()) { e.datagramAt = -Infinity; e.datagramTries = 0; }
  }
  detach(): void {
    this.dropDatagram(false); this.reliable = undefined; this.queued.clear();
  }
  attachDatagram(link: DatagramLink): void {
    this.dropDatagram(false); this.datagram = this.impairDatagram(link); this.attachedAt = this.now();
    this.lastProbe = -Infinity; this.proofAt = -Infinity; this.probes.clear();
  }
  dropDatagram(notify = true): void {
    const d = this.datagram; this.datagram = undefined;
    this.proofAt = -Infinity; this.probes.clear(); this.setFast(false);
    try { d?.close(); } catch { /* already closed */ }
    if (d && notify) this.onFastDown();
  }
  private setFast(next: boolean) {
    if (next !== this.fast) { this.fast = next; this.stats.fastTransitions++; this.onFastChange(next); }
  }
  sendControl(m: unknown): boolean {
    const data = stringify(m), ws = this.reliable;
    if (!ws?.open || ws.bufferedAmount > this.highWater) return false;
    try { if (!ws.send(data)) return false; } catch { return false; }
    this.stats.bytesSent += utf8Length(data); return true;
  }
  sendEvent(data: JsonInput): number { const seq = this.events.push(data); this.flush(); return seq; }
  /** Retains only the newest unsent payload per stream. Returns the state's seq (0 when offline).
   * An accepted enqueue is not a delivery guarantee; use `ack: true` and onStateAck to learn what arrived. */
  sendState(stream: number, data: Uint8Array, time: number, o: StateOptions = {}): number {
    if (!this.active) return 0;
    if (!isUint(stream, 65535) || !Number.isFinite(time) || data.length > this.maxStateBytes ||
        !(o.ttlMs === undefined || Number.isFinite(o.ttlMs) && o.ttlMs > 0) ||
        !(o.priority === undefined || Number.isFinite(o.priority) && o.priority >= 0)) throw new RangeError('Invalid state');
    if (!this.sequence.has(stream) && this.sequence.size >= this.maxStreams) throw new Error('State stream limit');
    const seq = ((this.sequence.get(stream) ?? 0) + 1) >>> 0 || 1; this.sequence.set(stream, seq);
    const old = this.queued.get(stream); if (old) this.stats.coalesced++;
    const now = this.now();
    this.queued.set(stream, { frame: { kind: o.ack ? FrameKind.stateAcked : FrameKind.state, epoch: this.epoch, stream, seq, time, payload: data.slice() },
      first: old?.first ?? now, deadline: now + (o.ttlMs ?? 100), priority: o.priority ?? 1 });
    return seq;
  }
  receiveControl(m: Record<string, unknown>): boolean {
    if (m.e !== this.epoch || !this.active) return false;
    if (m.t === 'event') {
      if (typeof m.s !== 'number' || !('d' in m)) throw new Error('Invalid event');
      try { this.events.receive(m.s, m.d as Json, this.onEvent); }
      catch (e) { if (!(e instanceof EventRejected)) throw e; this.rejected(e); }
      this.ackDue = !this.sendControl({ t: 'ack', e: this.epoch, s: this.events.received }); return true;
    }
    if (m.t === 'ack') {
      if (typeof m.s !== 'number') throw new Error('Invalid acknowledgement');
      if (this.events.ack(m.s)) this.onEventAck(m.s); return true;
    }
    return false;
  }
  receiveBinary(bytes: Uint8Array, via: 'ws' | 'rtc'): void {
    this.stats.bytesReceived += bytes.length;
    if (!this.active) return;
    const f = decodeFrame(bytes, this.maxFrameBytes, this.timeBase);
    if (!f) { this.stats.invalid++; return; }
    if (f.epoch !== this.epoch || (via === 'rtc' && !this.datagram)) { this.stats.stale++; return; }
    switch (f.kind) {
      case FrameKind.probe:
        if (via === 'rtc') this.sendFast(encodeFrame({ ...f, kind: FrameKind.reply }, this.timeBase));
        return;
      case FrameKind.reply: {
        if (via !== 'rtc') return;
        const sent = this.probes.get(f.seq);
        if (sent === undefined) return;   // (matched by seq; the time is ours, kept here)
        this.probes.delete(f.seq);
        const rtt = this.now() - sent;
        if (rtt < 0 || rtt > this.probeTimeout) return;
        this.proofAt = this.now(); this.stats.datagramRttMs = rtt; this.setFast(true); return;
      }
      case FrameKind.events: return this.receiveDatagramEvents(f);
      case FrameKind.sack: return this.receiveStateAcks(f);
    }
    const prior = this.received.get(f.stream);
    let late = false;
    if (prior !== undefined && !newer(f.seq, prior)) {
      // overtaken: dropped, or delivered once if recent and unseen (acks keep following the newest)
      const back = (prior - f.seq) >>> 0, mask = this.seen.get(f.stream) ?? 0, bit = back >= 1 && back <= 32 ? (1 << (back - 1)) >>> 0 : 0;
      if (!this.deliverLate || !bit || (mask & bit)) { this.stats.stale++; return; }
      this.seen.set(f.stream, (mask | bit) >>> 0); late = true;
    } else {
      if (prior === undefined && this.received.size >= this.maxStreams) { this.stats.invalid++; return; }
      if (this.deliverLate) {
        const d = prior === undefined ? 0 : (f.seq - prior) >>> 0, mask = this.seen.get(f.stream) ?? 0;
        this.seen.set(f.stream, !d || d > 32 ? 0 : ((d < 32 ? (mask << d) >>> 0 : 0) | (1 << (d - 1))) >>> 0);
      }
      this.received.set(f.stream, f.seq);
      if (f.kind === FrameKind.stateAcked) this.acksOut.set(f.stream, f.seq);
    }
    this.stats.statesReceived++;
    try { this.onState({ stream: f.stream, seq: f.seq, time: f.time, data: f.payload, via, late }); }
    catch (e) { this.callbackError(e); }
  }
  private callbackError(e: unknown): void {
    this.stats.callbackErrors++;
    try { this.onCallbackError(e); } catch { /* a diagnostics callback must not break delivery */ }
  }
  private rejected(e: EventRejected): void {
    this.stats.eventsRejected++; this.eventRetryAt = this.now() + 100; this.callbackError(e.error);
  }
  private receiveDatagramEvents(f: Frame): void {
    if (f.seq <= this.events.sentThrough && this.events.ack(f.seq)) this.onEventAck(f.seq);
    if (!f.payload.length) return;
    let list: unknown;
    try { list = JSON.parse(fromUtf8(f.payload)); } catch { this.stats.invalid++; return; }
    if (!Array.isArray(list) || list.length > 64) { this.stats.invalid++; return; }
    const before = this.events.received;
    try {
      for (const item of list) {
        if (!Array.isArray(item) || item.length !== 2 || !Number.isSafeInteger(item[0])) { this.stats.invalid++; return; }
        try { this.events.receive(item[0] as number, item[1] as Json, this.onEvent); }
        catch (e) { if (e instanceof EventRejected) { this.rejected(e); return; } this.stats.invalid++; return; }
      }
    } finally {
      const delivered = this.events.received - before;
      if (delivered > 0) { this.stats.eventsViaDatagram += delivered; this.ackDue = true; }
    }
  }
  private receiveStateAcks(f: Frame): void {
    const p = f.payload;
    if (p.length % 6) { this.stats.invalid++; return; }
    const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
    for (let at = 0; at < p.length; at += 6) {
      const stream = v.getUint16(at, true), seq = v.getUint32(at + 2, true), sent = this.sequence.get(stream);
      if (sent === undefined || newer(seq, sent)) continue;
      const prior = this.acksIn.get(stream);
      if (prior !== undefined && !newer(seq, prior)) continue;
      this.acksIn.set(stream, seq); this.stats.stateAcksReceived++;
      try { this.onStateAck(stream, seq); } catch (e) { this.callbackError(e); }
    }
  }
  private sendFast(b: Uint8Array): boolean {
    const d = this.datagram;
    if (!d?.open || d.bufferedAmount > this.highWater) return false;
    try { if (!d.send(b)) return false; } catch { return false; }
    this.stats.bytesSent += b.length; return true;
  }
  /** Binary on the datagram path when it is proven, else the WebSocket. */
  private sendBinary(b: Uint8Array, preferFast: boolean): boolean {
    const ws = this.reliable;
    if (preferFast && this.fastActive && this.datagram && this.datagram.bufferedAmount <= this.highWater) return this.sendFast(b);
    if (!ws?.open || ws.bufferedAmount > this.highWater) return false;
    try { if (!ws.send(b)) return false; } catch { return false; }
    this.stats.bytesSent += b.length; return true;
  }
  pump(): void {
    const now = this.now(), d = this.datagram;
    if (this.events.waiting && now >= this.eventRetryAt) {
      // an event the application rejected (or early copies that caught up): offer it again, in order
      const before = this.events.received;
      try { this.events.drain(this.onEvent); } catch (e) { if (e instanceof EventRejected) this.rejected(e); else throw e; }
      if (this.events.received > before) this.ackDue = true;
    }
    if (d) {
      if ((!d.open && now - this.attachedAt > this.probeTimeout) ||
          (this.fast && now - this.proofAt > this.probeTimeout) ||
          (!this.fast && now - this.attachedAt > this.probeTimeout * 2)) this.dropDatagram();
      else if (d.open && now - this.lastProbe >= this.probeInterval) {
        this.lastProbe = now;
        const seq = this.probeSeq = (this.probeSeq + 1) >>> 0;
        this.probes.set(seq, now);
        for (const [s, at] of this.probes) if (now - at > this.probeTimeout) this.probes.delete(s);
        this.sendFast(encodeFrame({ kind: FrameKind.probe, epoch: this.epoch, stream: 0, seq, time: this.timeBase, payload: new Uint8Array() }, this.timeBase));
      }
    }
    this.flush();
  }
  flush(maxPackets = 8): void {
    const ws = this.reliable, now = this.now();
    if (!ws?.open) return;
    if (this.ackDue) this.ackDue = !this.sendControl({ t: 'ack', e: this.epoch, s: this.events.received });
    for (const e of this.events.entries()) {
      if (e.seq <= this.lastEventSent) continue;
      const encoded = `{"t":"event","e":${this.epoch},"s":${e.seq},"d":${e.text}}`;
      const size = utf8Length(encoded);
      if (ws.bufferedAmount > this.highWater || !this.budget.take(size, now)) break;
      try { if (!ws.send(encoded)) break; } catch { break; }
      this.events.sent(e.seq); this.lastEventSent = e.seq; this.stats.bytesSent += size;
    }
    if (this.fastActive) this.flushDatagramEvents(now);
    if (this.acksOut.size && now - this.lastAckSentAt >= this.stateAckInterval) this.flushStateAcks(now);
    for (const [id, q] of this.queued) if (q.deadline <= now) { this.queued.delete(id); this.stats.expired++; }
    if (!this.queued.size) return;
    const queue = [...this.queued.values()].sort((a, b) =>
      (b.priority + (now - b.first) / 100) - (a.priority + (now - a.first) / 100));
    let count = 0;
    for (const q of queue) {
      if (count++ >= maxPackets) break;
      const b = encodeFrame(q.frame, this.timeBase);
      if (!this.budget.take(b.length, now)) break;
      if (!this.sendBinary(b, q.frame.payload.length <= this.datagramStateBytes)) { this.stats.congested++; break; }
      this.stats.statesSent++; this.queued.delete(q.frame.stream);
    }
  }
  /** Copies of WebSocket-sent, unacknowledged events, retried on the datagram path for UDP-like latency. */
  private flushDatagramEvents(now: number): void {
    const retry = Math.max(40, Math.min(200, this.stats.datagramRttMs * 1.5 + 10));
    const items: string[] = []; let bytes = 2;
    if (this.datagramEvents) for (const e of this.events.entries()) {
      if (e.seq > this.lastEventSent) break;
      if (e.datagramTries >= 6 || now - e.datagramAt < retry || e.bytes - 64 > DATAGRAM_EVENT_BYTES) continue;
      const item = `[${e.seq},${e.text}]`, size = utf8Length(item) + 1;
      if (bytes + size > DATAGRAM_EVENT_BYTES || items.length >= 64) break;
      items.push(item); bytes += size; e.datagramAt = now; e.datagramTries++;
    }
    const ackChanged = this.events.received !== this.datagramAcked;
    if (!items.length && !ackChanged) return;
    const payload = utf8('[' + items.join(',') + ']');
    if (this.sendFast(encodeFrame({ kind: FrameKind.events, epoch: this.epoch, stream: 0, seq: this.events.received >>> 0, time: this.timeBase, payload }, this.timeBase))) {
      this.datagramAcked = this.events.received; this.stats.datagramEventFrames++;
    }
  }
  private flushStateAcks(now: number): void {
    const pairs = [...this.acksOut].slice(0, 150), p = new Uint8Array(pairs.length * 6), v = new DataView(p.buffer);
    pairs.forEach(([stream, seq], i) => { v.setUint16(i * 6, stream, true); v.setUint32(i * 6 + 2, seq, true); });
    if (this.sendBinary(encodeFrame({ kind: FrameKind.sack, epoch: this.epoch, stream: 0, seq: 0, time: this.timeBase, payload: p }, this.timeBase), true)) {
      for (const [stream, seq] of pairs) if (this.acksOut.get(stream) === seq) this.acksOut.delete(stream);
      this.lastAckSentAt = now; this.stats.stateAcksSent++;
    }
  }
  /** Delays a stream-like link without ever reordering it: one queue, one timer. */
  private impairReliable(link: ReliableLink): ReliableLink {
    let tail = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const queue: { at: number; data: string | Uint8Array }[] = [];
    const drain = () => {
      timer = undefined;
      const t = performance.now();
      while (queue.length && queue[0]!.at <= t + 1) {
        const { data } = queue.shift()!;
        if (link.open) try { link.send(data); } catch { /* reconnect owns recovery */ }
      }
      if (queue.length) timer = setTimeout(drain, queue[0]!.at - t);
    };
    const self = this;
    return {
      get open() { return link.open; }, get bufferedAmount() { return link.bufferedAmount; },
      close: () => { queue.length = 0; clearTimeout(timer); timer = undefined; link.close(); },
      send(data) {
        const i = self.impairment;
        if (!i && !queue.length) return link.send(data);
        if (!link.open) return false;
        const stall = i?.stallMs && Math.random() < (i.loss ?? 0) ? i.stallMs : 0;
        if (stall) self.stats.impairedStalls++;
        const t = performance.now(), at = Math.max(tail, t + (i?.lagMs ?? 0) + Math.random() * (i?.jitterMs ?? 0) + stall); tail = at;
        queue.push({ at, data: typeof data === 'string' ? data : data.slice() });
        if (!timer) timer = setTimeout(drain, at - t);
        return true;
      },
    };
  }
  private impairDatagram(link: DatagramLink): DatagramLink {
    const self = this;
    return {
      get open() { return link.open; }, get bufferedAmount() { return link.bufferedAmount; }, close: () => link.close(),
      send(data) {
        const i = self.impairment;
        if (!i) return link.send(data);
        if (!link.open) return false;
        const copies = Math.random() < i.loss! ? 0 : Math.random() < i.duplicate! ? 2 : 1;
        if (!copies) self.stats.impairedDrops++;
        for (let n = 0; n < copies; n++) {
          const copy = data.slice();
          setTimeout(() => { if (link.open) try { link.send(copy); } catch { /* dropped */ } }, i.lagMs! + Math.random() * i.jitterMs!);
        }
        return true;
      },
    };
  }
}
