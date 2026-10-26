// The site runs Twinwire's real server code (GameServer, Lobby) in the page for its explainers. These are the few
// node:crypto calls that code makes, on top of the browser's Web Crypto.
const fill = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

class Bytes extends Uint8Array {
  readUInt16LE(at: number) { return new DataView(this.buffer, this.byteOffset, this.byteLength).getUint16(at, true); }
  readUInt32LE(at: number) { return new DataView(this.buffer, this.byteOffset, this.byteLength).getUint32(at, true); }
  override toString(encoding?: string): string {
    if (encoding === 'hex') return Array.from(this, b => b.toString(16).padStart(2, '0')).join('');
    const b64 = btoa(String.fromCharCode(...this));
    return encoding === 'base64url' ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : b64;
  }
}

export function randomBytes(n: number): Bytes { return new Bytes(fill(n)); }
export function randomInt(max: number): number {
  const limit = Math.floor(0x100000000 / max) * max;
  for (;;) { const v = new DataView(fill(4).buffer).getUint32(0, true); if (v < limit) return v % max; }
}
export function randomUUID(): string {
  if (typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const b = fill(16); b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function createHmac(): never { throw new Error('TURN credentials are minted on the server, not in the page'); }
export default { randomBytes, randomInt, randomUUID, createHmac };
