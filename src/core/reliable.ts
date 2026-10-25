import { stringify, utf8Length, type Json } from './protocol.js';
export interface PendingEvent { seq: number; data: Json; bytes: number; text: string; datagramAt: number; datagramTries: number }
export interface ReliableCheckpoint { next: number; received: number; acknowledged: number; pending: { seq: number; data: Json }[] }
export interface ReliableOptions { maxEvents?: number; maxBytes?: number; maxEventBytes?: number; maxEarly?: number }
/** Ordered event delivery with replay/deduplication within a retained logical session.
 * Copies may arrive on two paths (WebSocket and datagrams), so early events wait in a bounded buffer.
 * An ACK means the synchronous receiver accepted the event, NOT that a database transaction committed. */
export class ReliableEvents {
  private next = 1;
  received = 0;
  acknowledged = 0;
  private highestSent = 0;
  private bytes = 0;
  private pending = new Map<number, PendingEvent>();
  private early = new Map<number, Json>();
  readonly maxEvents: number;
  readonly maxBytes: number;
  readonly maxEventBytes: number;
  readonly maxEarly: number;
  constructor(o: ReliableOptions | number = {}, maxBytes?: number) {
    const opts: ReliableOptions = typeof o === 'number' ? { maxEvents: o, maxBytes } : o;
    this.maxEvents = opts.maxEvents ?? 512; this.maxBytes = opts.maxBytes ?? 1024 * 1024;
    this.maxEventBytes = opts.maxEventBytes ?? 64 * 1024; this.maxEarly = opts.maxEarly ?? 256;
    if (![this.maxEvents, this.maxBytes, this.maxEventBytes, this.maxEarly].every(v => Number.isInteger(v) && v > 0)) throw new RangeError('Invalid event limits');
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
  /** Returns how many events were delivered. Early events wait (bounded); duplicates are dropped. */
  receive(seq: number, data: Json, deliver: (data: Json, seq: number) => void): number {
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('Invalid event sequence');
    if (seq <= this.received) return 0;
    if (seq !== this.received + 1) {
      if (seq - this.received > this.maxEarly) throw new Error('Event sequence gap');
      if (!this.early.has(seq)) this.early.set(seq, data);
      return 0;
    }
    deliver(data, seq); this.received = seq;
    let n = 1;
    for (let s = seq + 1; this.early.has(s); s++) {
      deliver(this.early.get(s) as Json, s); this.early.delete(s); this.received = s; n++;
    }
    for (const s of this.early.keys()) if (s <= this.received) this.early.delete(s);
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
