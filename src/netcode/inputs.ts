import { isUint, MAX_STATE_BYTES } from '../core/protocol.js';
export interface BinaryInput { seq: number; data: Uint8Array }
/** Bundle recent inputs as redundancy without enabling retransmission of stale movement. */
export function encodeInputs(inputs: readonly BinaryInput[]): Uint8Array {
  if (!inputs.length || inputs.length > 32) throw new RangeError('Invalid input count');
  let size = 1, previous = -1;
  for (const input of inputs) {
    if (!isUint(input.seq) || input.seq <= previous || input.data.length > 1024) throw new RangeError('Invalid input');
    previous = input.seq; size += 6 + input.data.length;
  }
  if (size > MAX_STATE_BYTES) throw new RangeError('Input bundle exceeds one state frame');
  const b = new Uint8Array(size), v = new DataView(b.buffer); b[0] = inputs.length; let at = 1;
  for (const i of inputs) { v.setUint32(at, i.seq, true); v.setUint16(at + 4, i.data.length, true); b.set(i.data, at + 6); at += 6 + i.data.length; }
  return b;
}
export function decodeInputs(b: Uint8Array): BinaryInput[] | null {
  if (!b.length || b.length > MAX_STATE_BYTES || !b[0] || b[0] > 32) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), out: BinaryInput[] = []; let at = 1, previous = -1;
  for (let n = 0; n < b[0]; n++) {
    if (at + 6 > b.length) return null;
    const seq = v.getUint32(at, true), size = v.getUint16(at + 4, true);
    if (seq <= previous || size > 1024 || at + 6 + size > b.length) return null;
    out.push({ seq, data: b.slice(at + 6, at + 6 + size) }); previous = seq; at += 6 + size;
  }
  return at === b.length ? out : null;
}
