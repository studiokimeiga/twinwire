// Delivery contracts: sequence wraparound, acks, events mirrored on datagrams, redundancy bundles, handler throws (from an independent review).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameServer } from '../dist/server/index.js';
import { GameClient } from '../dist/client/index.js';
import { SnapshotHistory, diffEntities, applyEntityDelta, Predictor, InputInbox, encodeInputs, decodeInputs } from '../dist/netcode/index.js';
import { EventRejected, ReliableEvents } from '../dist/core/reliable.js';
import { encodeFrame, FrameKind, utf8 } from '../dist/core/protocol.js';
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

for (const maxRejections of [1, 3]) {
  test(`an event rejected ${maxRejections} time(s) is dropped once, and the events behind it still arrive in order`, () => {
    const p = pair({ events: { maxRejections } });
    let attempts = 0; const got = [], errors = [];
    p.b.onCallbackError = e => errors.push(e.message);
    p.b.onEvent = d => { if (d === 'poison') { attempts++; throw new Error('bad buy'); } got.push(d); };
    for (const d of ['before', 'poison', 'after-1', 'after-2']) p.a.sendEvent(d);
    for (let i = 0; i < 20; i++) p.advance(50);
    assert.equal(attempts, maxRejections);
    assert.deepEqual(got, ['before', 'after-1', 'after-2']);
    assert.equal(p.b.stats.eventsDropped, 1);
    assert.equal(p.a.events.size, 0);                               // the drop is acknowledged, so the sender stops replaying it
    assert.equal(errors.filter(m => /dropped/i.test(m)).length, 1);
  });
}

test('a handler that recovers within maxRejections still gets the event, once', () => {
  const p = pair({ events: { maxRejections: 3 } });
  let attempts = 0; const got = [];
  p.b.onEvent = d => { if (++attempts < 3) throw new Error('not yet'); got.push(d); };
  p.a.sendEvent('one');
  for (let i = 0; i < 20; i++) p.advance(50);
  assert.equal(attempts, 3);
  assert.deepEqual(got, ['one']);
  assert.equal(p.b.stats.eventsDropped, 0);
});

test('extra copies of a rejected event wait for the retry delay instead of using up its attempts', () => {
  const p = pair({ events: { maxRejections: 3 } });
  let attempts = 0;
  p.b.onEvent = () => { attempts++; throw new Error('bad buy'); };
  for (let i = 0; i < 5; i++) p.b.receiveControl({ t: 'event', e: 1, s: 1, d: 'poison' });
  assert.equal(attempts, 1);
  assert.equal(p.b.stats.eventsDropped, 0);
  p.advance(100);
  assert.equal(attempts, 2);
});

test('maxRejections: Infinity keeps offering a rejected event', () => {
  const p = pair({ events: { maxRejections: Infinity } });
  let attempts = 0; const got = [];
  p.b.onEvent = d => { if (d === 'poison') { attempts++; throw new Error('bad buy'); } got.push(d); };
  p.a.sendEvent('poison'); p.a.sendEvent('after');
  for (let i = 0; i < 40; i++) p.advance(150);
  assert.ok(attempts > 20, `only ${attempts} attempts`);
  assert.deepEqual(got, []);
  assert.equal(p.b.stats.eventsDropped, 0);
});

test('maxRejections must be a positive whole number or Infinity', () => {
  for (const maxRejections of [0, -1, 1.5, NaN]) assert.throws(() => pair({ events: { maxRejections } }), RangeError);
});

function holdingPoison(options) {
  const events = new ReliableEvents(options), got = [], dropped = [];
  events.onDropped = seq => dropped.push(seq);
  const deliver = d => { if (d === 'poison') throw new Error('bad buy'); got.push(d); };
  assert.throws(() => events.receive(1, 'poison', deliver), EventRejected);
  return { events, got, dropped, deliver };
}

test('when the queue behind a rejected event fills by count, the rejected event is given up, not the session', () => {
  const { events, got, dropped, deliver } = holdingPoison({ maxEarly: 4, maxRejections: 100 });
  for (let seq = 2; seq <= 8; seq++) events.receive(seq, seq, deliver);
  assert.deepEqual(dropped, [1]);
  assert.deepEqual(got, [2, 3, 4, 5, 6, 7, 8]);
  assert.equal(events.received, 8);
});

test('when the queue behind a rejected event fills by bytes, the rejected event is given up, not the session', () => {
  const { events, got, dropped, deliver } = holdingPoison({ maxEarlyBytes: 64, maxRejections: 100 });
  const pad = 'x'.repeat(40);
  for (let seq = 2; seq <= 4; seq++) events.receive(seq, pad, deliver);
  assert.deepEqual(dropped, [1]);
  assert.deepEqual(got, [pad, pad, pad]);
});

test('with maxRejections: Infinity a full queue stays a protocol error and nothing is dropped', () => {
  const { events, dropped, deliver } = holdingPoison({ maxEarly: 4, maxRejections: Infinity });
  for (let seq = 2; seq <= 4; seq++) events.receive(seq, seq, deliver);
  assert.throws(() => events.receive(5, 5, deliver), /gap/);
  assert.deepEqual(dropped, []);
});

test('a full queue gives a briefly rejected event one more offer before dropping it', () => {
  const events = new ReliableEvents({ maxEarly: 3, maxRejections: 100 }), got = [], dropped = [];
  events.onDropped = seq => dropped.push(seq);
  let ready = false;
  const deliver = d => { if (d === 'first' && !ready) throw new Error('not yet'); got.push(d); };
  assert.throws(() => events.receive(1, 'first', deliver), EventRejected);
  ready = true;
  for (let seq = 2; seq <= 5; seq++) events.receive(seq, seq, deliver);
  assert.deepEqual(dropped, []);
  assert.deepEqual(got, ['first', 2, 3, 4, 5]);
});

test('rejections while making room are counted, reported and wait for the retry delay', () => {
  const p = pair({ events: { maxEarly: 3, maxRejections: 100 } });
  const errors = [], attempts = { p1: 0, p2: 0 };
  p.b.onCallbackError = e => errors.push(e.message);
  p.b.onEvent = d => { attempts[d]++; throw new Error(`refused ${d}`); };
  for (const [s, d] of [[1, 'p1'], [2, 'p2'], [3, 'p2'], [4, 'p2']]) p.b.receiveControl({ t: 'event', e: 1, s, d });
  assert.equal(p.b.stats.eventsDropped, 1);
  assert.equal(p.b.stats.eventsRejected, 3);                        // p1 twice (first offer, last offer), then p2 once
  assert.equal(errors.filter(m => /refused p2/.test(m)).length, 1);
  p.b.pump();
  assert.equal(attempts.p2, 1);                                     // no time has passed: its retry isn't due
});

test('a drop on the datagram path lets the rest of the frame through and is not counted as delivered', () => {
  const p = pair({ events: { maxRejections: 1 } }); p.rtc();
  for (let i = 0; i < 10; i++) p.advance(20);
  const got = [];
  p.b.onEvent = d => { if (d === 'poison') throw new Error('bad buy'); got.push(d); };
  const payload = utf8('[[1,"poison"],[2,"after-1"],[3,"after-2"]]');
  p.b.receiveBinary(encodeFrame({ kind: FrameKind.events, epoch: 1, stream: 0, seq: 0, time: 0, payload }, 0), 'rtc');
  assert.deepEqual(got, ['after-1', 'after-2']);
  assert.equal(p.b.stats.eventsDropped, 1);
  assert.equal(p.b.stats.eventsViaDatagram, 2);
});

test('a client handler that keeps rejecting an event does not stall the events behind it', async () => {
  const s = await setup({ onSession: session => { session.sendEvent('poison'); session.sendEvent('after'); } });
  const c = new GameClient({ url: s.url, room: 'r', rtc: false, reconnectBaseMs: 20, endpoint: { events: { maxRejections: 2 } } });
  const got = []; c.onEvent = d => { if (d === 'poison') throw new Error('bad update'); got.push(d); };
  try {
    c.connect();
    await until(() => got.length || c.status === 'lost');
    assert.equal(c.status, 'online');
    assert.deepEqual(got, ['after']);
  } finally { c.close(); await s.server.close(); }
});

test('by default, a poison event cannot stall a real session or end it', async () => {
  const got = []; let session;
  const s = await setup({ onSession: x => { session = x; x.onEvent = d => { if (d === 'poison') throw new Error('bad buy'); got.push(d); }; } });
  const c = new GameClient({ url: s.url, room: 'r', rtc: false, reconnectBaseMs: 20 });
  let lost; c.onSessionLost = info => lost = info;
  try {
    c.connect(); await until(() => c.status === 'online');
    c.sendEvent('poison');
    const want = Array.from({ length: 300 }, (_, i) => i);
    for (const n of want) c.sendEvent(n);
    await until(() => got.length === want.length || c.status === 'lost', 8000);
    assert.equal(c.status, 'online', `client status ${c.status}, lost reason: ${lost?.reason}`);
    assert.deepEqual(got, want);
    assert.equal(session.endpoint.stats.eventsDropped, 1);
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
