import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, decodeFrame, newer, stringify, readControl, MAX_STATE_BYTES } from '../dist/core/protocol.js';
import { ReliableEvents } from '../dist/core/reliable.js';
import { TokenBucket, estimateEgress } from '../dist/core/budget.js';
import { pair } from './helpers.mjs';
const bytes = (...v) => Uint8Array.from(v);
const frame = (overrides = {}) => ({ kind: 1, epoch: 5, stream: 8, seq: 4, time: 12.5, payload: bytes(1, 2), ...overrides });
test('binary frames round trip with views having nonzero byte offsets', () => {
  const b = encodeFrame(frame()); const padded = new Uint8Array(b.length + 14); padded.set(b, 7);
  assert.deepEqual(decodeFrame(padded.subarray(7, 7 + b.length)), frame());
});
test('binary decoder rejects malformed, wrong-version and over-limit packets', () => {
  assert.equal(decodeFrame(bytes(1)), null);
  const good = () => encodeFrame(frame());
  const bad = f => { const b = good(); f(b); assert.equal(decodeFrame(b), null); };
  bad(b => { b[0] = (5 << 4) | 1; });          // another protocol version
  bad(b => { b[0] = (4 << 4) | 9; });          // an unknown kind
  bad(b => { b[1] = b[2] = 0; });               // epoch 0
  bad(b => { b[0] = (4 << 4) | 2; });           // a probe carrying a payload
  // the stream varint: overlong (a needless continuation), more than 3 bytes, or over 65535
  assert.equal(decodeFrame(Uint8Array.of(0x41, 5, 0, 0x88, 0x00, 4, 0, 0, 0, 0, 0, 0, 0)), null);
  assert.equal(decodeFrame(Uint8Array.of(0x41, 5, 0, 0xff, 0xff, 0xff, 0x01, 4, 0, 0, 0, 0, 0, 0, 0)), null);
  assert.equal(decodeFrame(Uint8Array.of(0x41, 5, 0, 0xff, 0xff, 0x7f, 4, 0, 0, 0, 0, 0, 0, 0)), null);
  assert.equal(decodeFrame(Uint8Array.of(0x44, 5, 0, 3, 4, 0, 0, 0, 0, 0, 0, 0)), null);   // events kind with a stream
  assert.equal(decodeFrame(new Uint8Array(1101)), null);
  assert.throws(() => encodeFrame(frame({ payload: new Uint8Array(MAX_STATE_BYTES + 1) })));
  assert.throws(() => encodeFrame(frame({ time: NaN })));
  assert.throws(() => encodeFrame(frame({ time: 7 * 86400000 })), 'a time over six days from the base');
  assert.throws(() => encodeFrame(frame({ epoch: 70000 })), 'the epoch is 16-bit');
  assert.throws(() => encodeFrame(frame({ kind: 2, stream: 0 })));
});
test('frame headers are 12 bytes for streams under 128, at most 14, and times survive to a quarter millisecond', () => {
  for (const [stream, header] of [[0, 12], [127, 12], [128, 13], [16383, 13], [16384, 14], [65535, 14]]) {
    const b = encodeFrame(frame({ stream })); assert.equal(b.length - 2, header, 'stream ' + stream);
    assert.equal(decodeFrame(b).stream, stream);
  }
  const base = 123456.789, f = decodeFrame(encodeFrame(frame({ time: base + 4000.25 }), base), 1 << 20, base);
  assert.equal(f.time - base, 4000.25);
  assert.equal(decodeFrame(encodeFrame(frame({ time: base - 30.5 }), base), 1 << 20, base).time - base, -30.5);
});
test('all single-byte truncations of a header are refused', () => {
  const b = encodeFrame(frame()); for (let n = 0; n < 12; n++) assert.equal(decodeFrame(b.subarray(0, n)), null);
  const wide = encodeFrame(frame({ stream: 20000 })); for (let n = 0; n < 14; n++) assert.equal(decodeFrame(wide.subarray(0, n)), null);
});
test('sequence comparison handles wraparound and equality', () => {
  assert.ok(newer(0, 0xffffffff)); assert.ok(newer(4, 2)); assert.ok(!newer(2, 4)); assert.ok(!newer(4, 4)); assert.ok(!newer(0xffffffff, 0));
});
test('JSON follows JSON.stringify: undefined fields drop, non-finite numbers become null; non-JSON and oversized values throw', () => {
  for (const value of [undefined, () => {}, 1n, { big: 1n }]) assert.throws(() => stringify(value));
  assert.equal(stringify({ a: undefined, b: NaN, c: [undefined, Infinity], d: 1 }), '{"b":null,"c":[null,null],"d":1}');
  assert.throws(() => stringify('x'.repeat(200000)), /too large/);
  assert.equal(readControl('[]'), null); assert.equal(readControl('{'), null);
  assert.equal(readControl(JSON.stringify({ t: 'x', s: '👋'.repeat(40000) })), null);
});
test('reliable events deliver once and in order, holding early copies from the datagram path', () => {  const r = new ReliableEvents(), delivered = [];  r.receive(1, 'a', d => delivered.push(d)); r.receive(1, 'a', d => delivered.push(d));  assert.equal(r.receive(3, 'c', d => delivered.push(d)), 0); assert.deepEqual(delivered, ['a']);  assert.equal(r.receive(2, 'b', d => delivered.push(d)), 2); r.receive(3, 'c', d => delivered.push(d));  assert.deepEqual(delivered, ['a', 'b', 'c']); assert.throws(() => r.receive(10000, 'far', () => {}), /gap/);  r.push('c'); assert.throws(() => r.ack(1)); r.sent(1); r.ack(1); assert.equal(r.size, 0);});
test('application rejection does not acknowledge an event', () => {
  const r = new ReliableEvents(); assert.throws(() => r.receive(1, 'x', () => { throw new Error('reject'); }));
  assert.equal(r.received, 0); r.receive(1, 'x', () => {}); assert.equal(r.received, 1);
});
test('outboxes are bounded and take ownership of payload values', () => {
  const r = new ReliableEvents({ maxEvents: 1 }), data = { x: 1 }; r.push(data); data.x = 99;
  assert.equal([...r.entries()][0].data.x, 1); assert.throws(() => r.push('second'));
});
test('reliable checkpoint restores counters and pending actions', () => {
  const a = new ReliableEvents(); a.push({ a: 1 }); a.push({ b: 2 }); a.sent(2); a.ack(1); a.receive(1, 1, () => {});
  const b = new ReliableEvents(); b.restore(a.checkpoint()); assert.deepEqual(b.checkpoint(), a.checkpoint());
  assert.throws(() => new ReliableEvents().restore({ next: 5, received: 0, acknowledged: 0, pending: [] }));
});
test('latest-wins coalesces state without replaying expired input', () => {
  const p = pair(), got = []; p.b.onState = s => got.push(s.data[0]);
  p.a.sendState(1, bytes(1), 0); p.a.sendState(1, bytes(2), 1); assert.equal(p.a.pendingStates, 1);
  p.advance(); assert.deepEqual(got, [2]);
  p.a.sendState(1, bytes(3), 2, { ttlMs: 10 }); p.advance(11); assert.deepEqual(got, [2]); assert.equal(p.a.stats.expired, 1);
});
test('state ownership is copied, not a mutable shared buffer', () => {
  const p = pair(), data = bytes(1); let got; p.b.onState = s => got = s.data[0]; p.a.sendState(1, data, 1); data[0] = 2; p.advance(); assert.equal(got, 1);
});
test('backpressure retains only newest state and keeps queues bounded', () => {
  const p = pair({ maxStreams: 2 }), got = []; p.b.onState = s => got.push(s.data[0]); p.blocked.bufferedA = 100000;
  for (let i = 0; i < 100; i++) p.a.sendState(1, bytes(i), 1);
  p.advance(); assert.equal(got.length, 0); assert.equal(p.a.pendingStates, 1);
  p.a.sendState(2, bytes(2), 2); assert.throws(() => p.a.sendState(3, bytes(3), 3));
  p.blocked.bufferedA = 0; p.advance(); assert.deepEqual(got, [99, 2]);
});
test('RTC is not selected merely because the data channel is open', () => {
  const p = pair(); p.rtc(); assert.equal(p.a.fastActive, false); p.advance(); assert.equal(p.a.fastActive, true); assert.equal(p.b.fastActive, true);
});
test('unilateral datagram blackhole falls back while WebSocket stays alive', () => {
  const p = pair(), via = []; p.b.onState = s => via.push(s.via); p.rtc(); p.advance();
  p.a.sendState(1, bytes(1), p.now); p.advance(); assert.deepEqual(via, ['rtc']);
  p.blocked.a = true;
  for (let i = 0; i < 8; i++) p.advance(20);
  assert.equal(p.a.fastActive, false); assert.equal(p.b.fastActive, false);
  p.a.sendState(1, bytes(2), p.now); p.advance(); assert.deepEqual(via, ['rtc', 'ws']);
});
test('datagrams can recover without creating a new logical session', () => {
  const p = pair(); p.rtc(); p.advance(); p.a.dropDatagram(); p.b.dropDatagram(); p.rtc(); p.advance();
  assert.ok(p.a.fastActive && p.b.fastActive); assert.equal(p.a.connectionEpoch, 1);
});
test('old epochs and reordered state cannot overwrite fresh state', () => {
  const p = pair(), got = []; p.b.onState = s => got.push(s.data[0]);
  const packet = seq => encodeFrame(frame({ epoch: 1, stream: 1, seq, payload: bytes(seq) }));
  p.b.receiveBinary(packet(2), 'ws'); p.b.receiveBinary(packet(1), 'ws'); p.b.receiveBinary(packet(2), 'ws');
  assert.deepEqual(got, [2]); p.reconnect(); p.b.receiveBinary(packet(3), 'ws'); assert.deepEqual(got, [2]);
});
test('event replay across a reconnect does not repeat already accepted actions', () => {
  const p = pair(), got = []; p.b.onEvent = d => got.push(d);
  p.a.sendEvent('x'); const [b, raw] = p.reliable.shift(); b.receiveControl(readControl(raw));
  p.reliable.length = 0; // connection lost after acceptance, before ACK delivery
  p.reconnect(); p.advance(); assert.deepEqual(got, ['x']); assert.equal(p.a.events.size, 0);
});
test('unknown ACKs are rejected instead of silently dropping unsent events', () => {
  const p = pair(); assert.throws(() => p.a.receiveControl({ t: 'ack', e: 1, s: 999 }));
});
test('token buckets respect burst, refill and backwards clocks', () => {
  const b = new TokenBucket(100, 100, 0); assert.ok(b.take(100, 0)); assert.ok(!b.take(1, -100)); assert.ok(b.take(50, 500)); assert.ok(!b.take(1, 500));
});
test('budget calculator distinguishes active hours and provider allowance', () => {
  const r = estimateEgress({ bytesPerSecondPerPlayer: 40000, averagePlayers: 50, activeHours: 720, baseMonthlyUSD: 5, includedGB: 1000, overageUSDPerGB: 0.01, overheadFraction: 0 });
  assert.equal(r.payloadGB, 5184); assert.equal(r.bill, 46.84); assert.equal(r.withinBudget, false);
});
test('seeded frame fuzz never escapes the decoder', () => {
  let x = 934; const next = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < 3000; i++) { const a = new Uint8Array(next() % 1150); for (let k = 0; k < a.length; k++) a[k] = next() & 255; assert.doesNotThrow(() => decodeFrame(a)); }
});

test('early events are bounded by size as well as count, and small ones still wait for the gap', () => {
  const r = new ReliableEvents(), big = 'x'.repeat(60000);
  assert.throws(() => { for (let s = 2; s < 40; s++) r.receive(s, big, () => {}); }, /early/i);
  const ok = new ReliableEvents(), got = [];
  for (let s = 2; s <= 200; s++) ok.receive(s, { n: s }, d => got.push(d.n));
  assert.equal(got.length, 0);
  ok.receive(1, { n: 1 }, d => got.push(d.n));
  assert.deepEqual(got, Array.from({ length: 200 }, (_, i) => i + 1));
  for (let s = 202; s < 260; s++) ok.receive(s, big.slice(0, 2000), () => {});   // freed bytes are reusable
});
