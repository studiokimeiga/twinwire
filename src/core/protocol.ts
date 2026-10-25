/** Versioned binary frames. All integer fields are little-endian. */
export const VERSION = 3;
export const HEADER_BYTES = 22;
/** A payload this size or smaller fits one datagram on any path we target (no SCTP/IP fragmentation). */
export const MTU_STATE_BYTES = 1100 - HEADER_BYTES;
/** Hard protocol ceiling for one frame. Endpoints choose a lower `maxStateBytes`. */
export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_STATE_BYTES = MAX_FRAME_BYTES - HEADER_BYTES;
export const DEFAULT_STATE_BYTES = 64 * 1024;
/** Upper bound of one JSON control/event message on the WebSocket. */
export const MAX_CONTROL_BYTES = 128 * 1024;
/** Kept for API compatibility: the largest datagram that avoids fragmentation. */
export const MAX_DATAGRAM_BYTES = 1100;
const MAGIC = 0x5754;   // "TW"
/**
 * state: latest-wins application bytes. stateAcked: the same, and the receiver reports the newest seq it saw (kind sack).
 * probe/reply: datagram liveness. events: reliable events mirrored on the datagram path (seq field = receiver ack).
 */
export const FrameKind = { state: 1, probe: 2, reply: 3, events: 4, sack: 5, stateAcked: 6 } as const;
export type FrameKind = typeof FrameKind[keyof typeof FrameKind];
const KINDS = new Set<number>(Object.values(FrameKind));
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** What sendEvent accepts: any JSON value, typed interfaces included (checked when it is serialized). */
export type JsonInput = Json | object;
export interface Frame {
  kind: FrameKind; epoch: number; stream: number; seq: number; time: number; payload: Uint8Array;
}
export const isUint = (v: unknown, max = 0xffffffff): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
const empty = (k: number) => k === FrameKind.probe || k === FrameKind.reply;
const streamed = (k: number) => k === FrameKind.state || k === FrameKind.stateAcked;
export function encodeFrame(f: Frame): Uint8Array {
  if (!KINDS.has(f.kind) || !isUint(f.epoch) || !f.epoch || !isUint(f.stream, 65535) ||
      !isUint(f.seq) || !Number.isFinite(f.time) || f.payload.length > MAX_STATE_BYTES ||
      (empty(f.kind) && f.payload.length !== 0) || (!streamed(f.kind) && f.stream !== 0)) throw new RangeError('Invalid frame');
  const b = new Uint8Array(HEADER_BYTES + f.payload.length), v = new DataView(b.buffer);
  v.setUint16(0, MAGIC, true); v.setUint8(2, VERSION); v.setUint8(3, f.kind);
  v.setUint32(4, f.epoch, true); v.setUint16(8, f.stream, true);
  v.setUint32(10, f.seq, true); v.setFloat64(14, f.time, true); b.set(f.payload, HEADER_BYTES);
  return b;
}
export function decodeFrame(b: Uint8Array, maxBytes = MAX_FRAME_BYTES): Frame | null {
  if (b.byteLength < HEADER_BYTES || b.byteLength > Math.min(maxBytes, MAX_FRAME_BYTES)) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint16(0, true) !== MAGIC || v.getUint8(2) !== VERSION) return null;
  const kind = v.getUint8(3), epoch = v.getUint32(4, true), time = v.getFloat64(14, true), stream = v.getUint16(8, true);
  if (!KINDS.has(kind) || !epoch || !Number.isFinite(time) ||
      (empty(kind) && b.byteLength !== HEADER_BYTES) || (!streamed(kind) && stream !== 0)) return null;
  return { kind: kind as FrameKind, epoch, stream, seq: v.getUint32(10, true), time, payload: b.slice(HEADER_BYTES) };
}
/** RFC-1982-style comparison. Live windows must be smaller than half the sequence space. */
export function newer(a: number, b: number): boolean { return a !== b && ((a - b) >>> 0) < 0x80000000; }
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const encoder = new TextEncoder(), decoder = new TextDecoder();
export const utf8 = (s: string) => encoder.encode(s);
export const fromUtf8 = (b: Uint8Array) => decoder.decode(b);
/** UTF-8 byte length without allocating. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; } else n += 3;
  }
  return n;
}
export function readControl(raw: string, maxBytes = MAX_CONTROL_BYTES): Record<string, unknown> | null {
  if (raw.length > maxBytes || utf8Length(raw) > maxBytes) return null;
  try { const m: unknown = JSON.parse(raw); return record(m) && typeof m.t === 'string' ? m : null; } catch { return null; }
}
/** Standard JSON semantics, as games expect from JSON.stringify: undefined, functions and symbols inside objects are
 * left out (null in arrays) and NaN/Infinity become null. A top-level value that isn't JSON, a BigInt or an oversized
 * result throws. */
export function stringify(value: unknown, maxBytes = MAX_CONTROL_BYTES): string {
  const s = JSON.stringify(value) as string | undefined;
  if (s === undefined) throw new TypeError('Value is not JSON');
  if (utf8Length(s) > maxBytes) throw new RangeError('Control frame too large');
  return s;
}
