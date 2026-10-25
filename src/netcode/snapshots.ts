import { newer } from '../core/protocol.js';
import type { Json } from '../core/protocol.js';
/**
 * What was sent, by state seq, so the next snapshot can be a delta against the newest one the receiver acknowledged
 * (send with `ack: true`, feed onStateAck to acknowledge). Lost snapshots cost nothing but a larger next delta.
 * Reset on a new connection epoch (the seqs restart) or a world reset.
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
