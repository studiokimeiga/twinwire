import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkClock, FixedStepper, Timeline, AdaptivePlayback, Predictor, InputInbox, SpatialGrid, defineSchema,
  ReplicaSender, ReplicaReceiver, encodeReplica, decodeReplica, lerp, lerpAngle, rewindTime } from '../dist/netcode/index.js';
test('clock uses correlated exchanges and keeps server time monotonic', () => {
  const c = new NetworkClock(); c.observe(0, 20, 1010); assert.equal(c.serverTime(20), 1020); assert.equal(c.rttMs, 20);
  c.observe(20, 40, 1010); c.advance(20); assert.ok(c.serverTime(40) >= 1020); assert.ok(!c.observe(20, 0, 0));
});
test('fixed steps do not depend on render-frame size', () => {
  const a = new FixedStepper(20), b = new FixedStepper(20); let x = 0, y = 0;
  for (let i = 0; i < 100; i++) a.advance(10, dt => x += dt);
  for (let i = 0; i < 25; i++) b.advance(40, dt => y += dt);
  assert.equal(a.tick, 20); assert.equal(b.tick, 20); assert.equal(x, y);
});
test('CPU stalls have bounded catch-up and observable skipped time', () => {
  const f = new FixedStepper(60, 4); let n = 0; f.advance(5000, () => n++); assert.equal(n, 4); assert.ok(f.overruns); assert.ok(f.droppedMs > 4900);
});
test('interpolation sorts reordering and refuses duplicate samples', () => {
  const t = new Timeline(); t.insert({ seq: 2, time: 100, value: 10 }); t.insert({ seq: 1, time: 0, value: 0 });
  assert.equal(t.insert({ seq: 2, time: 150, value: 15 }), false);
  assert.equal(t.sample(50, lerp).value, 5); assert.equal(t.sample(-1, lerp), null);
});
test('teleports are steps, not fast movement across the level', () => {
  const t = new Timeline(); t.insert({ seq: 1, time: 0, value: 0 }); t.insert({ seq: 2, time: 100, value: 100, discontinuity: true });
  assert.equal(t.sample(99, lerp).value, 0); assert.equal(t.sample(100, lerp).value, 100);
});
test('extrapolation is capped and snapshot values cannot be mutated through sampling', () => {
  const t = new Timeline(); t.insert({ seq: 1, time: 0, value: { x: 0 } }); t.insert({ seq: 2, time: 100, value: { x: 10 } });
  const s = t.sample(1000, (a,b,u) => ({ x: lerp(a.x,b.x,u) }), (a,p,ahead,dt) => ({ x: a.x+(a.x-p.x)*ahead/dt }), 50);
  assert.equal(s.value.x, 15); s.value.x = 900; assert.equal(t.sample(100, (a,b) => a).value.x, 10);
});
test('increasing the jitter buffer never rewinds playback', () => {
  const p = new AdaptivePlayback(30, 30, 400); let last = p.advance(100, 16);
  for (let now = 116; now < 800; now += 16) { p.observe(now, now - 350); const next = p.advance(now, 16); assert.ok(next >= last); last = next; }
  assert.ok(p.delayMs > 300);
});
test('prediction replays only unacknowledged inputs and ignores old snapshots', () => {
  const p = new Predictor({ x: 0 }, (s, input, dt) => ({ x: s.x + input * dt }), 1);
  p.push(1); p.push(1); p.push(1); assert.equal(p.state.x, 3);
  p.reconcile({ ack: 1, tick: 10, state: { x: 0.8 } }); assert.equal(p.state.x, 2.8); assert.equal(p.pendingCount, 2);
  assert.equal(p.reconcile({ ack: 0, tick: 9, state: { x: 0 } }), false);
  assert.throws(() => p.reconcile({ ack: 100, tick: 11, state: { x: 0 } }));
});
test('same input ACK with a newer server tick can still update authoritative state', () => {
  const p = new Predictor(0, (s,i) => s+i, 1); p.push(1); p.reconcile({ ack: 1, tick: 1, state: 1 }); p.reconcile({ ack: 1, tick: 2, state: 2 }); assert.equal(p.state, 2);
});
test('prediction overflow is explicit instead of silently losing reconciliation history', () => {
  const p = new Predictor(0, (s,i) => s+i, 1, 1); p.push(1); assert.throws(() => p.push(1)); p.resync(10, 2); assert.equal(p.state, 10); assert.equal(p.pendingCount, 0);
});
test('redundant input batches are deduplicated and acknowledged only when applied', () => {
  const q = new InputInbox(); assert.ok(q.add({ seq: 2, value: 'two' })); assert.equal(q.next(), null);
  assert.ok(q.add({ seq: 1, value: 'one' })); assert.equal(q.applied, 0); assert.equal(q.next().value, 'one'); assert.equal(q.next().value, 'two'); assert.equal(q.applied, 2);
  assert.equal(q.add({ seq: 1, value: 'dup' }), false); assert.equal(q.add({ seq: 99999, value: 'future' }), false);
});
test('spatial queries return nearby candidates without leaking distant entities', () => {
  const g = new SpatialGrid(10); g.upsert('a', { x: -1, y: -1 }); g.upsert('b', { x: 40, y: 40 });
  assert.deepEqual([...g.query({ x: 0, y: 0 }, 5)], ['a']); g.upsert('a', { x: 40, y: 40 }); assert.equal(g.query({ x: 0, y: 0 }, 5).size, 0);
  g.remove('b'); assert.equal(g.query({ x: 40, y: 40 }, 0).size, 1); assert.throws(() => g.query({ x: 0, y: 0 }, 1e9));
});
test('binary schema quantizes positions, respects view offsets and rejects corrupt values', () => {
  const c = defineSchema({ x: { type: 'i16', scale: 100 }, flags: { type: 'u8' }, y: { type: 'f32' } });
  const b = c.encode({ x: 1.234, flags: 3, y: 2.5 }); assert.equal(b.length, 7);
  const out = c.decode(b); assert.equal(out.x, 1.23); assert.equal(out.flags, 3); assert.equal(out.y, 2.5);
  assert.throws(() => c.encode({ x: 10000, flags: 3, y: 2.5 })); assert.throws(() => c.encode({ x: 1, flags: 300, y: 2.5 }));
  assert.equal(c.decode(b.subarray(1)), null);
});
test('replication retries a lost final state until acknowledged', () => {
  const tx = new ReplicaSender(), rx = new ReplicaReceiver(); tx.publish(1, 1, Uint8Array.of(7));
  const first = tx.due(0)[0]; tx.markSent(first, 0); assert.equal(tx.due(50).length, 0);
  const retry = tx.due(101)[0]; assert.ok(retry); tx.markSent(retry, 101);
  const response = rx.apply(decodeReplica(encodeReplica(retry))); tx.acknowledge(response.ack); assert.equal(tx.due(250).length, 0); assert.equal(rx.get(1)[0], 7);
});
test('replication rejects an unsent acknowledgement and ignores old entity generations', () => {
  const tx = new ReplicaSender(), rx = new ReplicaReceiver(); const v = tx.publish(1, 1, Uint8Array.of(1)); assert.equal(tx.acknowledge(v), false);
  const a = tx.due(0)[0]; rx.apply(a); tx.publish(1, 2, Uint8Array.of(2)); const b = tx.due(0)[0]; rx.apply(b); assert.equal(rx.apply(a).changed, false); assert.equal(rx.get(1)[0], 2);
});
test('despawn tombstones prevent late packets from resurrecting entities', () => {
  const tx = new ReplicaSender(), rx = new ReplicaReceiver(); tx.publish(1, 1, Uint8Array.of(1)); const a = tx.due(0)[0]; rx.apply(a);
  tx.publish(1, 1, null); const tomb = tx.due(1)[0]; rx.apply(tomb); rx.apply(a); assert.equal(rx.get(1), null);
});
test('angle interpolation crosses the short arc and rewind is server-bounded', () => {
  assert.ok(Math.abs(lerpAngle(3.1, -3.1, .5) - Math.PI) < .001);
  assert.equal(rewindTime(0, 1000, 200), 800); assert.equal(rewindTime(9999, 1000, 200), 1000);
});

test('default clones work where structuredClone must be called bare (browsers throw Illegal invocation otherwise)', async () => {
  const { Timeline, Predictor, InputInbox } = await import('../dist/netcode/index.js');
  const real = globalThis.structuredClone;
  globalThis.structuredClone = function (v) { if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation'); return real(v); };
  try {
    const t = new Timeline(); t.insert({ time: 1, seq: 1, value: { x: 1 } }); t.insert({ time: 2, seq: 2, value: { x: 3 } });
    assert.equal(t.sample(1.5, (a, b, u) => ({ x: a.x + (b.x - a.x) * u })).value.x, 2);
    const p = new Predictor({ x: 0 }, (s, i) => ({ x: s.x + i }), 1 / 60); p.push(1); p.push(1);
    assert.ok(p.reconcile({ ack: 1, tick: 1, state: { x: 1 } })); assert.equal(p.state.x, 2);
    const inbox = new InputInbox(); assert.ok(inbox.add({ seq: 1, value: { dx: 1 } })); assert.equal(inbox.next().value.dx, 1);
  } finally { globalThis.structuredClone = real; }
});
