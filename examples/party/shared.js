// What the server and the browser share: the arena, how a player moves, and the binary formats. The server runs move()
// for real; the browser runs the same function ahead of it (prediction) and corrects itself from the server's snapshots.
import { defineSchema } from 'twinwire/netcode';

export const W = 640, H = 360, SPEED = 160, TICK_HZ = 60, SNAP_HZ = 20, RADIUS = 9;
export const COLORS = ['#ff6a7a', '#6ab8ff', '#7ae08a', '#ffd23f', '#c88cff', '#ff9a4a', '#5ae0d0', '#f080b8'];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// one fixed step of one player: input is { dx, dy } in -1..1
export function move(p, input, dt) {
  const len = Math.hypot(input.dx, input.dy);
  if (!len) return { x: p.x, y: p.y };
  const k = Math.min(1, len) / len;
  return { x: clamp(p.x + input.dx * k * SPEED * dt, RADIUS, W - RADIUS), y: clamp(p.y + input.dy * k * SPEED * dt, RADIUS, H - RADIUS) };
}
export const spawn = seat => ({ x: 80 + (seat % 4) * 160, y: 100 + Math.floor(seat / 4) * 160 });

// an input: two signed bytes (sent in bundles of the last few, so a lost packet costs nothing)
export const inputCodec = defineSchema({ dx: { type: 'i8', scale: 100 }, dy: { type: 'i8', scale: 100 } });

// a snapshot: the server tick, the last input of yours it applied, then every player (seat, x, y)
export function encodeSnapshot(tick, ack, players) {
  const b = new Uint8Array(9 + players.length * 5), v = new DataView(b.buffer);
  v.setUint32(0, tick, true); v.setUint32(4, ack, true); v.setUint8(8, players.length);
  players.forEach((p, i) => { const o = 9 + i * 5; v.setUint8(o, p.seat); v.setUint16(o + 1, Math.round(p.x * 50), true); v.setUint16(o + 3, Math.round(p.y * 50), true); });
  return b;
}
export function decodeSnapshot(b) {
  if (b.length < 9) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), n = v.getUint8(8);
  if (b.length !== 9 + n * 5) return null;
  const players = [];
  for (let i = 0; i < n; i++) { const o = 9 + i * 5; players.push({ seat: v.getUint8(o), x: v.getUint16(o + 1, true) / 50, y: v.getUint16(o + 3, true) / 50 }); }
  return { tick: v.getUint32(0, true), ack: v.getUint32(4, true), players };
}
