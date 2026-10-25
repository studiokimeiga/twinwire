import { stringify, utf8Length, type Json } from './protocol.js';
export interface PendingEvent { seq: number; data: Json; bytes: number; text: string; datagramAt: number; datagramTries: number }
export interface ReliableCheckpoint { next: number; received: number; acknowledged: number; pending: { seq: number; data: Json }[] }
export interface ReliableOptions { maxEvents?: number; maxBytes?: number; maxEventBytes?: number; maxEarly?: number; maxEarlyBytes?: number }
/** The application's event handler threw: the event wasn't accepted and will be offered again. */
export class EventRejected extends Error {
  constructor(readonly error: unknown) { super('Event handler threw: ' + (error instanceof Error ? error.message : String(error))); }
}
/** Ordered event delivery with replay/deduplication within a retained logical session.
 * Copies may arrive on two paths (WebSocket and datagrams), so early events wait in a buffer bounded by count and
 * size (only datagram copies arrive early, and they are small: a peer can't park megabytes there).
 * An ACK means the synchronous receiver accepted the event, NOT that a database transaction committed. */
export class ReliableEvents {
  private next = 1;
  received = 0;
  acknowledged = 0;
  private highestSent = 0;
  private bytes = 0;
  private pending = new Map<number, PendingEvent>();
  private early = new Map<number, { data: Json; bytes: number }>();
  private earlyBytes = 0;
  readonly maxEvents: number;
  readonly maxBytes: number;
  readonly maxEventBytes: number;
  readonly maxEarly: number;
  readonly maxEarlyBytes: number;
  constructor(o: ReliableOptions | number = {}, maxBytes?: number) {
    const opts: ReliableOptions = typeof o === 'number' ? { maxEvents: o, maxBytes } : o;
    this.maxEvents = opts.maxEvents ?? 512; this.maxBytes = opts.maxBytes ?? 1024 * 1024;
    this.maxEventBytes = opts.maxEventBytes ?? 64 * 1024; this.maxEarly = opts.maxEarly ?? 256;
    this.maxEarlyBytes = opts.maxEarlyBytes ?? 256 * 1024;
    if (![this.maxEvents, this.maxBytes, this.maxEventBytes, this.maxEarly, this.maxEarlyBytes].every(v => Number.isInteger(v) && v > 0)) throw new RangeError('Invalid event limits');
  }
  push(data: Json): number {
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
   * throws, the event wasn't accepted: it is kept at the head and `drain` tries it again (EventRejected is thrown). */
  receive(seq: number, data: Json, deliver: (data: Json, seq: number) => void): number {
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('Invalid event sequence');
    if (seq <= this.received) return 0;
    if (seq !== this.received + 1) {
      if (seq - this.received > this.maxEarly) throw new Error('Event sequence gap');
      if (!this.early.has(seq)) {
        const bytes = utf8Length(stringify(data, this.maxEventBytes));
        if (this.earlyBytes + bytes > this.maxEarlyBytes) throw new Error('Too many early event bytes');
        this.early.set(seq, { data, bytes }); this.earlyBytes += bytes;
      }
      return 0;
    }
    if (this.early.has(seq)) return this.drain(deliver);   // a rejected copy is already waiting at the head
    try { deliver(data, seq); }
    catch (error) {
      const bytes = utf8Length(stringify(data, this.maxEventBytes));
      this.early.set(seq, { data, bytes }); this.earlyBytes += bytes;
      throw new EventRejected(error);
    }
    this.received = seq;
    return 1 + this.drain(deliver);
  }
  /** The next event in order is waiting (early copies caught up, or one the receiver rejected). */
  get waiting(): boolean { return this.early.has(this.received + 1); }
  /** Deliver what's waiting, in order. Throws EventRejected, keeping that event, when `deliver` throws. */
  drain(deliver: (data: Json, seq: number) => void): number {
    let n = 0;
    for (let s = this.received + 1, e = this.early.get(s); e; s++, e = this.early.get(s)) {
      try { deliver(e.data, s); } catch (error) { throw new EventRejected(error); }
      this.early.delete(s); this.earlyBytes -= e.bytes; this.received = s; n++;
    }
    for (const [s, e] of this.early) if (s <= this.received) { this.early.delete(s); this.earlyBytes -= e.bytes; }
    return n;
  }
  checkpoint(): ReliableCheckpoint {
    return { next: this.next, received: this.received, acknowledged: this.acknowledged,
      pending: Array.from(this.pending.values(), e => ({ seq: e.seq, data: structuredClone(e.data) })) };
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
}
