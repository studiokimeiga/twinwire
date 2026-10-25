// Delivery contracts: sequence wraparound, acks, events mirrored on datagrams, redundancy bundles, handler throws (from an independent review).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameServer } from '../dist/server/index.js';
import { GameClient } from '../dist/client/index.js';
import { SnapshotHistory, diffEntities, applyEntityDelta, Predictor, InputInbox, encodeInputs, decodeInputs } from '../dist/netcode/index.js';
import { pair, until, sleep } from './helpers.mjs';

const W = 0xffffffff;

test('state seq wraps from 0xffffffff to 1; receiver keeps accepting, stale copies stay stale, acks follow', async () => {
  const p = pair(); const seen = [], acked = [];
  p.b.onState = s => seen.push(s.seq); p.a.onStateAck = (stream, seq) => acked.push(seq);
  p.a['sequence'].set(3, W - 2);
  const sent = [];
  for (let i = 0; i < 4; i++) { sent.push(p.a.sendState(3, Uint8Array.of(i), p.now, { ack: true })); p.advance(60); }
  assert.deepEqual(sent, [W - 1, W, 1, 2]);
  assert.deepEqual(seen, [W - 1, W, 1, 2]);
  p.advance(60);                                    // the receiver's ack interval: one more round for the last ack
  assert.deepEqual(acked, [W - 1, W, 1, 2]);
  // a late duplicate from before the wrap is stale
  const stale = p.b.stats.stale;
  p.a['sequence'].set(3, W - 1); p.a.sendState(3, Uint8Array.of(9), p.now); p.advance(60);
  assert.deepEqual(seen, [W - 1, W, 1, 2]); assert.equal(p.b.stats.stale, stale + 1);
});

test('SnapshotHistory acknowledges across the wrap and never regresses', () => {
  const h = new SnapshotHistory();
  h.record(W, 'a'); h.record(1, 'b'); h.record(2, 'c');
  assert.equal(h.acknowledge(W), true); assert.equal(h.baseline.seq, W);
  assert.equal(h.acknowledge(2), true); assert.equal(h.baseline.value, 'c');
  assert.equal(h.acknowledge(1), false); assert.equal(h.acknowledge(W), false);
});

test('mirrored events arrive in order from reordered datagrams, once, and are acked without the WebSocket', () => {
  const p = pair(); p.rtc();
  for (let i = 0; i < 10; i++) p.advance(20);
  assert.ok(p.a.fastActive && p.b.fastActive);
  const got = []; p.b.onEvent = (d, s) => got.push(s);
  for (let i = 1; i <= 8; i++) p.a.sendEvent({ n: i, pad: 'x'.repeat(250) });   // several datagram frames
  const heldWs = p.reliable.splice(0);                                           // WebSocket copies held back
  const frames = p.fast.splice(0).reverse();                                     // datagrams reordered
  assert.ok(frames.length > 1);
  for (const [peer, d] of frames) peer.receiveBinary(d, 'rtc');
  assert.deepEqual(got, [1, 2, 3, 4, 5, 6, 7, 8]);
  // b acknowledges on the datagram path; a's outbox empties with the WebSocket still held
  p.b.pump(); for (const [peer, d] of p.fast.splice(0)) peer.receiveBinary(d, 'rtc');
  assert.equal(p.a.events.size, 0);
  // the late WebSocket copies are duplicates
  for (const [peer, d] of heldWs) if (typeof d === 'string') peer.receiveControl(JSON.parse(d));
  assert.deepEqual(got, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('a throw from onEvent on the datagram path means the event comes again', () => {
  const p = pair(); p.rtc();
  for (let i = 0; i < 10; i++) p.advance(20);
  let calls = 0; const got = []; p.b.onEvent = (d, s) => { if (!calls++) throw new Error('not yet'); got.push(s); };
  p.a.sendEvent('one'); p.reliable.splice(0);                       // datagram copy only
  for (const [peer, d] of p.fast.splice(0)) peer.receiveBinary(d, 'rtc');
  assert.deepEqual(got, []);
  for (let i = 0; i < 10 && !got.length; i++) { p.blocked.b = false; p.advance(50); }
  assert.deepEqual(got, [1]);
});

async function setup(options = {}) {
  const errors = [];
  const server = await createGameServer({ origins: ['http://localhost'], allowMissingOrigin: true, onError: e => errors.push(e.message), ...options });
  const port = await server.listen();
  return { server, errors, url: `ws://127.0.0.1:${port}/connect` };
}

test('a throw from the server onEvent means the event comes again (API.md), not session loss', async () => {
  let calls = 0; const got = [];
  const s = await setup({ onSession: session => { session.onEvent = d => { if (!calls++) throw new Error('not yet'); got.push(d); }; } });
  const c = new GameClient({ url: s.url, room: 'r', rtc: false, reconnectBaseMs: 20 });
  let lost; c.onSessionLost = info => lost = info;
  try {
    c.connect(); await until(() => c.status === 'online');
    c.sendEvent('buy-1');
    await until(() => got.length || c.status === 'lost');
    await sleep(100);
    assert.equal(c.status, 'online', `client status ${c.status}, lost reason: ${lost?.reason}`);
    assert.deepEqual(got, ['buy-1']);
  } finally { c.close(); await s.server.close(); }
});

test('a throw from the client onEvent means the event comes again (API.md), not session loss', async () => {
  const s = await setup({ onSession: session => session.sendEvent('hello') });
  const c = new GameClient({ url: s.url, room: 'r', rtc: false, reconnectBaseMs: 20 });
  let calls = 0; const got = []; c.onEvent = d => { if (!calls++) throw new Error('not yet'); got.push(d); };
  let lost; c.onSessionLost = info => lost = info;
  try {
    c.connect();
    await until(() => got.length || c.status === 'lost');
    await sleep(100);
    assert.equal(c.status, 'online', `client status ${c.status}, lost reason: ${lost?.reason}`);
    assert.deepEqual(got, ['hello']);
  } finally { c.close(); await s.server.close(); }
});

test('redundant input bundles survive loss: every input applied once, in order', () => {
  const pred = new Predictor({ x: 0 }, (s, i) => ({ x: s.x + i }), 1 / 60);
  const inbox = new InputInbox(); const applied = [];
  for (let n = 1; n <= 200; n++) {
    pred.push(1);
    const bundle = encodeInputs(pred.recent(3).map(i => ({ seq: i.seq, data: Uint8Array.of(i.value) })));
    if (n % 3 === 0 || n % 7 === 0) continue;                      // lost, never three in a row
    for (const i of decodeInputs(bundle)) inbox.add({ seq: i.seq, value: i.data[0] });
    for (let x; (x = inbox.next());) applied.push(x.seq);
    pred.reconcile({ ack: inbox.applied, tick: n, state: { x: inbox.applied } });
  }
  assert.deepEqual(applied, Array.from({ length: applied.length }, (_, i) => i + 1));
  assert.ok(applied.length >= 199); assert.equal(pred.state.x, 200);
  const ok = encodeInputs([{ seq: 5, data: Uint8Array.of(1) }, { seq: 6, data: Uint8Array.of(2) }]);
  assert.equal(decodeInputs(Uint8Array.of(...ok, 0)), null);                 // trailing byte
  assert.equal(decodeInputs(ok.subarray(0, ok.length - 1)), null);           // truncated
  const swapped = ok.slice(); swapped[1] = 7;                                // 7 then 6: not ascending
  assert.equal(decodeInputs(swapped), null);
  assert.equal(decodeInputs(Uint8Array.of(0)), null); assert.equal(decodeInputs(Uint8Array.of(33)), null);
});

test('entity deltas rebuild entities whose ids are Object.prototype names', () => {
  const world = { constructor: { hp: 3 }, toString: { hp: 4 }, p1: { hp: 5 } };
  const wire = JSON.parse(JSON.stringify(diffEntities(null, world)));
  let view;
  try { view = applyEntityDelta(null, wire); }
  finally { delete Object.hp; delete Object.prototype.toString.hp; }
  assert.deepEqual(Object.keys(view).sort(), ['constructor', 'p1', 'toString']);
  assert.deepEqual(view.constructor, { hp: 3 });
});

test('datagram-only recovery: a lost first frame and an outbox larger than maxEarly still deliver every event in order', () => {
  const p = pair(); p.rtc();
  for (let i = 0; i < 10; i++) p.advance(20);
  const got = []; p.b.onEvent = (d, s) => got.push(s);
  for (let i = 1; i <= 300; i++) p.a.sendEvent(i);
  p.reliable.length = 0;                                   // every WebSocket copy is lost
  p.fast.shift();                                          // the first mirrored frame is lost
  // events never go on the WebSocket again in this epoch, so from here on they can only arrive as datagram copies
  for (let round = 0; round < 400 && got.length < 300; round++) p.advance(20);
  console.log('# delivered', got.length, 'invalid', p.b.stats.invalid, 'a outbox', p.a.events.size);
  assert.deepEqual(got, Array.from({ length: 300 }, (_, i) => i + 1));
  for (let i = 0; i < 10; i++) p.advance(20);
  assert.equal(p.a.events.size, 0);                        // the tail is acknowledged too
});
