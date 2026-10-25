/** Versioned binary frames. Integers are little-endian.
 * [version << 4 | kind: 1] [connection epoch: 2] [stream: varint, 1 to 3] [seq: 4] [time: 4, signed, in 1/4 ms since the
 * connection's time base] [payload]. 12 bytes for streams under 128. */
export const VERSION = 4;
/** The longest header (a stream of 16384 or more). */
export const HEADER_BYTES = 14;
/** A payload this size or smaller fits one datagram on any path we target (no SCTP/IP fragmentation). */
export const MTU_STATE_BYTES = 1100 - HEADER_BYTES;
/** Hard protocol ceiling for one frame. Endpoints choose a lower `maxStateBytes`. */
export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_STATE_BYTES = MAX_FRAME_BYTES - HEADER_BYTES;
export const DEFAULT_STATE_BYTES = 64 * 1024;
/** Upper bound of one JSON control/event message on the WebSocket. */
export const MAX_CONTROL_BYTES = 128 * 1024;
/** A frame's time is (time - base) in quarter milliseconds as a signed 32-bit number: about six days either way from
 * the connection's time base (the server reconnects older connections before that). */
const TIME_UNITS = 4;
export const MAX_TIME_SPAN_MS = 0x7fffffff / TIME_UNITS;
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
/** `base`: the connection's time base (both ends know it from the welcome); `time` travels relative to it. */
export function encodeFrame(f: Frame, base = 0): Uint8Array {
  const rel = f.time - base;
  if (!KINDS.has(f.kind) || !isUint(f.epoch, 0xffff) || !f.epoch || !isUint(f.stream, 0xffff) ||
      !isUint(f.seq) || !(Math.abs(rel) <= MAX_TIME_SPAN_MS) || f.payload.length > MAX_STATE_BYTES ||
      (empty(f.kind) && f.payload.length !== 0) || (!streamed(f.kind) && f.stream !== 0)) throw new RangeError('Invalid frame');
  const sb = f.stream < 0x80 ? 1 : f.stream < 0x4000 ? 2 : 3, at = 3 + sb;
  const b = new Uint8Array(at + 8 + f.payload.length), v = new DataView(b.buffer);
  b[0] = VERSION << 4 | f.kind; v.setUint16(1, f.epoch, true);
  for (let i = 3, s = f.stream; i < at; i++, s >>>= 7) b[i] = (s & 0x7f) | (i < at - 1 ? 0x80 : 0);
  v.setUint32(at, f.seq, true); v.setInt32(at + 4, Math.round(rel * TIME_UNITS), true); b.set(f.payload, at + 8);
  return b;
}
export function decodeFrame(b: Uint8Array, maxBytes = MAX_FRAME_BYTES, base = 0): Frame | null {
  if (b.byteLength < 12 || b.byteLength > Math.min(maxBytes, MAX_FRAME_BYTES) || b[0]! >> 4 !== VERSION) return null;
  const kind = b[0]! & 15, v = new DataView(b.buffer, b.byteOffset, b.byteLength), epoch = v.getUint16(1, true);
  // the stream: a varint of at most 3 bytes, in its shortest form
  let at = 3, stream = 0;
  for (let shift = 0; ; shift += 7) {
    const byte = b[at++]!; stream |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) { if (at > 4 && !byte) return null; break; }
    if (at >= 6) return null;
  }
  if (!KINDS.has(kind) || !epoch || stream > 0xffff || at + 8 > b.byteLength ||
      (empty(kind) && b.byteLength !== at + 8) || (!streamed(kind) && stream !== 0)) return null;
  return { kind: kind as FrameKind, epoch, stream, seq: v.getUint32(at, true), time: base + v.getInt32(at + 4, true) / TIME_UNITS, payload: b.slice(at + 8) };
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
