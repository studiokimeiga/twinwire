import { newer } from '../core/protocol.js';
import type { Json } from '../core/protocol.js';
/**
 * What was sent, by state seq, so the next snapshot can be a delta against the newest one the receiver acknowledged
 * (send with `ack: true`, feed onStateAck to acknowledge). Lost snapshots cost nothing but a larger next delta.
 * An acknowledged base more than `capacity` seqs old is dropped, so the next snapshot is whole: use the same capacity
 * as the receiver's SnapshotBaselines. Reset on a new connection epoch (the seqs restart) or a world reset.
 */
export class SnapshotHistory<T> {
  private sent = new Map<number, T>();
  private acked: { seq: number; value: T } | null = null;
  constructor(readonly capacity = 64) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('Invalid history capacity');
  }
  record(seq: number, value: T): void {
    if (!seq) return;
    this.sent.set(seq, value);
    while (this.sent.size > this.capacity) this.sent.delete(this.sent.keys().next().value!);
    // A receiver keeps only the last `capacity` seqs (SnapshotBaselines). Past that, the acknowledged base may be gone,
    // and every delta against it would be refused: send a whole snapshot until a newer one is acknowledged.
    if (this.acked && ((seq - this.acked.seq) >>> 0) >= this.capacity && newer(seq, this.acked.seq)) this.acked = null;
  }
  acknowledge(seq: number): boolean {
    const value = this.sent.get(seq);
    if (value === undefined || this.acked && !newer(seq, this.acked.seq)) return false;
    this.acked = { seq, value };
    for (const k of [...this.sent.keys()]) if (!newer(k, seq)) this.sent.delete(k);
    return true;
  }
  /** The acknowledged snapshot to diff against, or null for a whole snapshot. */
  get baseline(): { seq: number; value: T } | null { return this.acked; }
  reset(): void { this.sent.clear(); this.acked = null; }
}
/**
 * The receiving side of SnapshotHistory: what was built from each snapshot, by state seq, so a delta can find its base.
 * Keeps seqs within `capacity` of the newest it was given, the same window SnapshotHistory builds on, so with equal
 * capacities (default 64) every delta's base is still here if it was stored. A missing base means the delta can't be
 * used: refuse it (return false from onState or the receiver's apply) so it isn't acknowledged.
 */
export class SnapshotBaselines<T> {
  private kept = new Map<number, T>();
  private newest: number | null = null;
  constructor(readonly capacity = 64) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('Invalid baseline capacity');
  }
  get size() { return this.kept.size; }
  set(seq: number, value: T): void {
    if (!seq) return;
    if (this.newest === null || newer(seq, this.newest)) this.newest = seq;
    else if (((this.newest - seq) >>> 0) >= this.capacity) return;
    this.kept.set(seq, value);
    for (const k of [...this.kept.keys()]) if (((this.newest - k) >>> 0) >= this.capacity) this.kept.delete(k);
  }
  /** The value stored for `seq`, or undefined if it was never stored or has left the window. */
  get(seq: number): T | undefined { return seq ? this.kept.get(seq) : undefined; }
  reset(): void { this.kept.clear(); this.newest = null; }
}
export type Entities = Record<string, Record<string, Json>>;
/** Field-level difference between two entity maps: changed fields per entity, and removed entities. */
export interface EntityDelta { set?: Entities; del?: string[] }
const same = (a: Json | undefined, b: Json | undefined) => a === b || (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null && JSON.stringify(a) === JSON.stringify(b));
// Ids and field names can be anything a player types ("constructor", "__proto__"): only own properties count, and
// they are defined rather than assigned so no name reaches a prototype.
const own = (o: object | null | undefined, k: string): boolean => !!o && Object.prototype.hasOwnProperty.call(o, k);
function put<T>(o: Record<string, T>, k: string, v: T): void {
  Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
}
export function diffEntities(base: Entities | null, next: Entities): EntityDelta {
  const out: EntityDelta = {};
  for (const id of Object.keys(next)) {
    const n = next[id]!, b = own(base, id) ? base![id] : undefined;
    let fields: Record<string, Json> | undefined;
    for (const k of Object.keys(n)) if (!b || !own(b, k) || !same(b[k], n[k])) put(fields ??= {}, k, n[k]!);
    if (b) for (const k of Object.keys(b)) if (!own(n, k)) put(fields ??= {}, k, null);
    if (fields) put(out.set ??= {}, id, fields);
  }
  if (base) for (const id of Object.keys(base)) if (!own(next, id)) (out.del ??= []).push(id);
  return out;
}
/** Rebuild the full map from the baseline the delta was made against. Inputs are not modified. */
export function applyEntityDelta(base: Entities | null, delta: EntityDelta): Entities {
  const out: Entities = {};
  if (base) for (const id of Object.keys(base)) put(out, id, { ...base[id] });
  for (const id of delta.del ?? []) if (own(out, id)) delete out[id];
  for (const [id, fields] of Object.entries(delta.set ?? {})) {
    if (!own(out, id)) put(out, id, {});
    const e = out[id]!, was = own(base, id) ? base![id] : undefined;
    for (const [k, v] of Object.entries(fields)) { if (v === null && was && own(was, k)) delete e[k]; else put(e, k, v); }
  }
  return out;
}
