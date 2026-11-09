import { cloneNetcodeValue } from './clone.js';
import { stringify, utf8Length, type Json, type JsonInput } from './protocol.js';
export interface PendingEvent { seq: number; data: Json; bytes: number; text: string; datagramAt: number; datagramTries: number }
export interface ReliableCheckpoint { next: number; received: number; acknowledged: number; pending: { seq: number; data: Json }[] }
export interface ReliableOptions {
  maxEvents?: number; maxBytes?: number; maxEventBytes?: number; maxEarly?: number; maxEarlyBytes?: number;
  /** How many times the handler may reject one event before it is dropped, so it can't hold up the events behind it. */
  maxRejections?: number;
}
/** The application's event handler threw: the event wasn't accepted. It is offered again unless it was just dropped. */
export class EventRejected extends Error {
  constructor(readonly error: unknown) { super('Event handler threw: ' + (error instanceof Error ? error.message : String(error))); }
}
/** Ordered event delivery with replay/deduplication within a retained logical session.
 * Copies may arrive on two paths (WebSocket and datagrams), so early events wait in a buffer bounded by count and
 * size (only datagram copies arrive early, and they are small: a peer can't park megabytes there).
 * An ACK means the sender can forget the event: the synchronous receiver accepted it or, after `maxRejections`, gave up
 * on it. It does NOT mean that a database transaction committed. */
export class ReliableEvents {
  private next = 1;
  received = 0;
  acknowledged = 0;
  private highestSent = 0;
  private bytes = 0;
  private pending = new Map<number, PendingEvent>();
  private early = new Map<number, { data: Json; bytes: number }>();
  private earlyBytes = 0;
  private rejections = 0;
  private rejectedWith: unknown;
  readonly maxEvents: number;
  readonly maxBytes: number;
  readonly maxEventBytes: number;
  readonly maxEarly: number;
  readonly maxEarlyBytes: number;
  readonly maxRejections: number;
  /** The handler refused an offer of the next event in order. */
  onRejected: (error: unknown) => void = () => {};
  /** An event the handler kept rejecting was given up on; the sequence moves past it. */
  onDropped: (seq: number, attempts: number, error: unknown) => void = () => {};
  constructor(opts: ReliableOptions = {}) {
    this.maxEvents = opts.maxEvents ?? 512; this.maxBytes = opts.maxBytes ?? 1024 * 1024;
    this.maxEventBytes = opts.maxEventBytes ?? 64 * 1024; this.maxEarly = opts.maxEarly ?? 256;
    this.maxEarlyBytes = opts.maxEarlyBytes ?? 256 * 1024; this.maxRejections = opts.maxRejections ?? 10;
    const limited = [this.maxEvents, this.maxBytes, this.maxEventBytes, this.maxEarly, this.maxEarlyBytes];
    if (this.maxRejections !== Infinity) limited.push(this.maxRejections);
    if (!limited.every(v => Number.isInteger(v) && v > 0)) throw new RangeError('Invalid event limits');
  }
  push(data: JsonInput): number {
    const text = stringify(data, this.maxEventBytes), bytes = utf8Length(text) + 64;
    if (bytes > this.maxEventBytes + 64) throw new RangeError('Event payload too large');
    if (this.pending.size >= this.maxEvents || this.bytes + bytes > this.maxBytes) throw new Error('Reliable outbox full');
    if (!Number.isSafeInteger(this.next + 1)) throw new Error('Reliable sequence exhausted');
    const seq = this.next++;
    this.pending.set(seq, { seq, data: JSON.parse(text) as Json, bytes, text, datagramAt: -Infinity, datagramTries: 0 }); this.bytes += bytes; return seq;
  }
  get size() { return this.pending.size; }
  get queuedBytes() { return this.bytes; }
  get sentThrough() { return this.highestSent; }
  get queuedThrough() { return this.next - 1; }
  entries(): IterableIterator<PendingEvent> { return this.pending.values(); }
  sent(seq: number) { this.highestSent = Math.max(this.highestSent, seq); }
  ack(seq: number): boolean {
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > this.highestSent) throw new Error('Invalid event acknowledgement');
    if (seq <= this.acknowledged) return false;
    this.acknowledged = seq;
    for (const [id, e] of this.pending) { if (id > seq) break; this.pending.delete(id); this.bytes -= e.bytes; }
    return true;
  }
  /** Returns how many events were delivered. Early events wait (bounded); duplicates are dropped. When `deliver`
   * throws, the event wasn't accepted: it is kept at the head and `drain` tries it again (EventRejected is thrown),
   * up to `maxRejections` attempts in all. A queue with no room left offers it once more and then gives up on it.
   * A repeated copy of a waiting event doesn't count as an offer: retries come only from `drain`. */
  receive(seq: number, data: Json, deliver: (data: Json, seq: number) => void): number {
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('Invalid event sequence');
    if (seq <= this.received) return 0;
    let delivered = 0;
    if (seq !== this.received + 1 && !this.early.has(seq)) {
      const yielding = () => this.rejections > 0 && this.maxRejections !== Infinity;
      const far = () => seq - this.received > this.maxEarly;
      if (far() && !yielding()) throw new Error('Event sequence gap');
      const bytes = utf8Length(stringify(data, this.maxEventBytes));
      const full = () => far() || this.earlyBytes + bytes > this.maxEarlyBytes;
      while (yielding() && full()) delivered += this.makeRoom(deliver);
      if (seq !== this.received + 1) {
        if (full()) throw new Error(far() ? 'Event sequence gap' : 'Too many early event bytes');
        this.early.set(seq, { data, bytes }); this.earlyBytes += bytes;
        return delivered;
      }
    }
    if (this.early.has(seq)) return 0;   // a copy is already waiting: `drain` offers it when its retry is due
    try { deliver(data, seq); }
    catch (error) {
      const bytes = utf8Length(stringify(data, this.maxEventBytes));
      this.early.set(seq, { data, bytes }); this.earlyBytes += bytes;
      throw this.rejected(seq, error);
    }
    this.received = seq;
    return delivered + 1 + this.drain(deliver);
  }
  /** The next event in order is waiting (early copies caught up, or one the receiver rejected). */
  get waiting(): boolean { return this.early.has(this.received + 1); }
  /** The handler has rejected the next event in order and it is still being held for another attempt. */
  get holding(): boolean { return this.rejections > 0; }
  /** Deliver what's waiting, in order. Throws EventRejected, keeping that event, when `deliver` throws. */
  drain(deliver: (data: Json, seq: number) => void): number {
    let n = 0;
    for (let s = this.received + 1, e = this.early.get(s); e; s++, e = this.early.get(s)) {
      try { deliver(e.data, s); } catch (error) { throw this.rejected(s, error); }
      this.early.delete(s); this.earlyBytes -= e.bytes; this.received = s; this.rejections = 0; n++;
    }
    for (const [s, e] of this.early) if (s <= this.received) { this.early.delete(s); this.earlyBytes -= e.bytes; }
    return n;
  }
  private rejected(seq: number, error: unknown): EventRejected {
    this.rejectedWith = error; this.rejections++;
    this.onRejected(error);
    if (this.rejections >= this.maxRejections) this.drop(seq);
    return new EventRejected(error);
  }
  private drop(seq: number): void {
    const attempts = this.rejections, error = this.rejectedWith, e = this.early.get(seq)!;
    this.early.delete(seq); this.earlyBytes -= e.bytes; this.received = seq;
    this.rejections = 0; this.rejectedWith = undefined;
    this.onDropped(seq, attempts, error);
  }
  /** Offer the held event one last time, drop it if refused, and deliver what was queued behind it. Stops at the next
   * event the handler holds, which keeps its own attempts. */
  private makeRoom(deliver: (data: Json, seq: number) => void): number {
    const held = this.received + 1;
    for (;;) {
      try { return this.drain(deliver); }
      catch (error) {
        if (!(error instanceof EventRejected)) throw error;
        if (!this.rejections) continue;                // it reached maxRejections and is already gone
        if (this.received + 1 !== held) return 0;
        this.drop(held);
      }
    }
  }
  checkpoint(): ReliableCheckpoint {
    return { next: this.next, received: this.received, acknowledged: this.acknowledged,
      pending: Array.from(this.pending.values(), e => ({ seq: e.seq, data: cloneNetcodeValue(e.data) })) };
  }
  restore(s: ReliableCheckpoint): void {
    if (this.next !== 1 || this.received || this.pending.size) throw new Error('Restore requires a fresh channel');
    if (![s.next, s.received, s.acknowledged].every(v => Number.isSafeInteger(v) && v >= 0) ||
        s.next < 1 || s.acknowledged >= s.next || !Array.isArray(s.pending) || s.pending.length > this.maxEvents)
      throw new Error('Invalid checkpoint');
    if (s.pending.length !== s.next - s.acknowledged - 1) throw new Error('Incomplete checkpoint');
    const saved: PendingEvent[] = []; let total = 0, expected = s.acknowledged + 1;
    for (const e of s.pending) {
      if (e.seq !== expected++) throw new Error('Invalid checkpoint sequence');
      const text = stringify(e.data, this.maxEventBytes), bytes = utf8Length(text) + 64;
      saved.push({ seq: e.seq, data: JSON.parse(text) as Json, bytes, text, datagramAt: -Infinity, datagramTries: 0 }); total += bytes;
    }
    if (total > this.maxBytes) throw new Error('Checkpoint exceeds outbox limit');
    this.next = s.next; this.received = s.received; this.acknowledged = s.acknowledged; this.highestSent = s.next - 1;
    this.pending = new Map(saved.map(e => [e.seq, e])); this.bytes = total;
  }
  /** Line this channel up with the peer's counters when a session resumes, before anything is sent on the new
   * connection. A checkpoint can be older than the session: the page that saved it went on to send and receive more.
   * The peer accepted events this channel never knew about, so anything still unsent moves past them (otherwise those
   * sequence numbers would be dropped as duplicates). Returns how many inbound events the peer has already forgotten
   * and this channel will never see. Those numbers are skipped, or the events behind them would wait forever. */
  realign(peerReceived: number, peerAcknowledged: number): number {
    if (![peerReceived, peerAcknowledged].every(v => Number.isSafeInteger(v) && v >= 0)) throw new Error('Invalid resume counters');
    if (peerReceived > this.highestSent) {
      const unsent = [...this.pending.values()].filter(e => e.seq > this.highestSent);
      let seq = peerReceived, total = 0;
      for (const e of unsent) { e.seq = ++seq; total += e.bytes; }
      this.pending = new Map(unsent.map(e => [e.seq, e])); this.bytes = total;
      this.next = seq + 1; this.acknowledged = this.highestSent = peerReceived;
    }
    const missed = peerAcknowledged - this.received;
    if (missed <= 0) return 0;
    this.received = peerAcknowledged; this.rejections = 0; this.rejectedWith = undefined;
    for (const [s, e] of this.early) if (s <= this.received) { this.early.delete(s); this.earlyBytes -= e.bytes; }
    return missed;
  }
}
