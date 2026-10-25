import { isUint } from '../core/protocol.js';
export interface Version { id: number; generation: number; revision: number }
export interface ReplicaUpdate extends Version { deleted: boolean; data: Uint8Array }
interface Retained { update: ReplicaUpdate; ack: number; sent: number; sentAt: number }
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => b[i] === v);
/** One instance per receiver. Whole small entity records are resent until acknowledged.
 * This intentionally does not depend on an unacknowledged delta baseline. */
export class ReplicaSender {
  private records = new Map<number, Retained>();
  constructor(readonly maxEntities = 1024, readonly retryMs = 100) {}
  publish(id: number, generation: number, data: Uint8Array | null): Version {
    if (!isUint(id, 65535) || !isUint(generation) || generation < 1 || (data?.length ?? 0) > 1067) throw new RangeError('Invalid entity');
    const old = this.records.get(id), deleted = data === null, bytes = data?.slice() ?? new Uint8Array();
    if (!old && this.records.size >= this.maxEntities) throw new Error('Replica entity limit');
    if (old && generation < old.update.generation) throw new Error('Entity generation regressed');
    if (old && generation === old.update.generation && old.update.deleted === deleted && sameBytes(old.update.data, bytes)) return { id, generation, revision: old.update.revision };
    const revision = old && generation === old.update.generation ? old.update.revision + 1 : 1;
    if (revision > 0xffffffff) throw new Error('Entity revision exhausted');
    const update = { id, generation, revision, deleted, data: bytes };
    this.records.set(id, { update, ack: old && generation === old.update.generation ? old.ack : 0, sent: 0, sentAt: -Infinity });
    return { id, generation, revision };
  }
  due(now: number, limit = 64): ReplicaUpdate[] {
    return [...this.records.values()].filter(r => r.ack < r.update.revision && now - r.sentAt >= this.retryMs)
      .sort((a, b) => a.sentAt - b.sentAt).slice(0, limit).map(r => ({ ...r.update, data: r.update.data.slice() }));
  }
  markSent(v: Version, now: number): void {
    const r = this.records.get(v.id); if (!r || r.update.generation !== v.generation || r.update.revision !== v.revision) return;
    r.sent = v.revision; r.sentAt = now;
  }
  acknowledge(v: Version): boolean {
    const r = this.records.get(v.id);
    if (!r || r.update.generation !== v.generation || !isUint(v.revision) || v.revision > r.sent) return false;
    r.ack = Math.max(r.ack, v.revision); return true;
  }
  /** Reset both sender and receiver under a new world/session generation, not while old packets remain valid. */
  clear(): void { this.records.clear(); }
}
export class ReplicaReceiver {
  private records = new Map<number, ReplicaUpdate>();
  constructor(readonly maxEntities = 1024) {}
  apply(u: ReplicaUpdate): { changed: boolean; ack: Version } {
    if (!isUint(u.id, 65535) || !isUint(u.generation) || !u.generation || !isUint(u.revision) || !u.revision || u.data.length > 1067) throw new Error('Invalid entity update');
    const old = this.records.get(u.id);
    if (!old && this.records.size >= this.maxEntities) throw new Error('Replica receiver full');
    const changed = !old || u.generation > old.generation || u.generation === old.generation && u.revision > old.revision;
    if (changed) this.records.set(u.id, { ...u, data: u.data.slice() });
    return { changed, ack: { id: u.id, generation: u.generation, revision: u.revision } };
  }
  get(id: number): Uint8Array | null { const r = this.records.get(id); return r && !r.deleted ? r.data.slice() : null; }
  clear(): void { this.records.clear(); }
}
export function encodeReplica(u: ReplicaUpdate): Uint8Array {
  if (!isUint(u.id, 65535) || !isUint(u.generation) || !u.generation || !isUint(u.revision) || !u.revision || u.data.length > 1067 || u.deleted && u.data.length)
    throw new Error('Invalid entity update');
  const b = new Uint8Array(11 + u.data.length), v = new DataView(b.buffer);
  v.setUint16(0, u.id, true); v.setUint32(2, u.generation, true); v.setUint32(6, u.revision, true); v.setUint8(10, +u.deleted);
  b.set(u.data, 11); return b;
}
export function decodeReplica(b: Uint8Array): ReplicaUpdate | null {
  if (b.length < 11 || b.length > 1078) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), flag = v.getUint8(10), generation = v.getUint32(2, true), revision = v.getUint32(6, true);
  if (flag > 1 || !generation || !revision || flag && b.length !== 11) return null;
  return { id: v.getUint16(0, true), generation, revision, deleted: !!flag, data: b.slice(11) };
}
