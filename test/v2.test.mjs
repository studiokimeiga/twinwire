import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Endpoint } from '../dist/core/endpoint.js';
import { TokenBucket } from '../dist/core/budget.js';
import { encodeFrame, decodeFrame, FrameKind, readControl } from '../dist/core/protocol.js';
import { validIceServers } from '../dist/core/rtc.js';
import { createGameServer, turnCredentials, cloudflareTurn } from '../dist/server/index.js';
import { GameClient } from '../dist/client/index.js';
import { pair, until, sleep } from './helpers.mjs';

test('a burst-sized message goes once the bucket is full, and the debt delays what follows', () => {
  const b = new TokenBucket(1000, 100, 0);
  assert.equal(b.take(5000, 0), true, 'larger than the burst, but the bucket was full');
  assert.equal(b.take(1, 1000), false, 'still paying the debt');
  assert.equal(b.take(1, 5000), true);
});

test('64 KiB states cross the WebSocket path whole, and frames over the limit are refused', () => {
  const p = pair({ bytesPerSecond: 1e6 }), got = [];
  p.b.onState = s => got.push(s);
  const big = new Uint8Array(60000).map((_, i) => i % 251);
  p.a.sendState(3, big, 1); p.advance();
  assert.equal(got.length, 1); assert.equal(got[0].data.length, 60000); assert.equal(got[0].data[59999], 59999 % 251);
  assert.throws(() => p.a.sendState(3, new Uint8Array(70000), 2), /Invalid state/);
  const small = new Endpoint({ maxStateBytes: 2000 });
  assert.equal(decodeFrame(encodeFrame({ kind: FrameKind.state, epoch: 1, stream: 0, seq: 1, time: 0, payload: new Uint8Array(3000) }), small.maxFrameBytes), null);
});

test('large states use the WebSocket even when datagrams are proven; small ones use datagrams', () => {
  const p = pair({ bytesPerSecond: 1e6, datagramStateBytes: 2000 }), got = [];
  p.b.onState = s => got.push(s.via);
  p.rtc(); for (let i = 0; i < 3; i++) p.advance();
  assert.ok(p.a.fastActive);
  p.a.sendState(1, new Uint8Array(100), 1); p.a.sendState(2, new Uint8Array(5000), 1); p.advance();
  assert.deepEqual(got.sort(), ['rtc', 'ws']);
});

test('state acknowledgements report the newest seq the receiver saw, per stream', () => {
  const p = pair({ stateAckIntervalMs: 0 }), acks = [];
  p.a.onStateAck = (stream, seq) => acks.push([stream, seq]);
  const s1 = p.a.sendState(5, Uint8Array.of(1), 1, { ack: true }); p.advance();
  const s2 = p.a.sendState(5, Uint8Array.of(2), 2, { ack: true }); p.advance(); p.advance();
  p.a.sendState(6, Uint8Array.of(3), 3); p.advance(); p.advance();
  assert.deepEqual(acks, [[5, s1], [5, s2]]); assert.equal(p.a.stateAck(5), s2); assert.equal(p.a.stateAck(6), undefined);
});

test('events travel on the datagram path too, so they arrive even while the WebSocket is stalled', () => {
  const p = pair(), got = [];
  p.b.onEvent = d => got.push(d);
  p.rtc(); for (let i = 0; i < 3; i++) p.advance();
  assert.ok(p.a.fastActive && p.b.fastActive);
  // hold every WebSocket message a sends: only the datagram copy can arrive
  p.a.sendEvent('hit'); p.a.flush();
  const held = p.reliable.splice(0).filter(([peer]) => peer === p.b);
  p.advance();
  assert.deepEqual(got, ['hit']); assert.equal(p.b.stats.eventsViaDatagram, 1);
  // the datagram ack clears a's outbox without the WebSocket
  p.advance(); assert.equal(p.a.events.size, 0);
  // the late WebSocket copy is a duplicate
  for (const [peer, data] of held) typeof data === 'string' ? peer.receiveControl(readControl(data)) : peer.receiveBinary(data, 'ws');
  assert.deepEqual(got, ['hit']);
});

test('datagram event frames that are malformed are counted and ignored', () => {
  const p = pair(); p.rtc(); for (let i = 0; i < 3; i++) p.advance();
  const bad = encodeFrame({ kind: FrameKind.events, epoch: 1, stream: 0, seq: 0, time: 0, payload: new TextEncoder().encode('{nope') });
  p.b.receiveBinary(bad, 'rtc'); assert.equal(p.b.stats.invalid, 1);
});

test('impairment drops datagrams and delays WebSocket sends in order', async () => {
  const e = new Endpoint({ impair: { loss: 1 } }), sent = [];
  e.attach(1, { open: true, bufferedAmount: 0, send: d => (sent.push(d), true), close() {} });
  e.attachDatagram({ open: true, bufferedAmount: 0, send: d => (sent.push(d), true), close() {} });
  e.pump(); await sleep(5);
  assert.equal(sent.filter(d => typeof d !== 'string').length, 0); assert.ok(e.stats.impairedDrops >= 1);
  e.setImpairment({ lagMs: 30, jitterMs: 30 });
  const order = [];
  const f = new Endpoint({ impair: { lagMs: 20, jitterMs: 40 } });
  f.attach(1, { open: true, bufferedAmount: 0, send: d => (order.push(JSON.parse(d).s), true), close() {} });
  for (let i = 0; i < 5; i++) f.sendEvent(i);
  assert.equal(order.length, 0); await until(() => order.length === 5, 2000);
  assert.deepEqual(order, [1, 2, 3, 4, 5]);
  assert.throws(() => f.setImpairment({ loss: 2 }));
});

test('impairment can stall the WebSocket like a retransmitted TCP segment, keeping order', async () => {
  const sent = [], e = new Endpoint({ impair: { loss: 1, stallMs: 80 } });
  e.attach(1, { open: true, bufferedAmount: 0, send: d => (sent.push(d), true), close() {} });
  const t0 = performance.now();
  for (let i = 0; i < 3; i++) e.sendEvent(i);
  await sleep(40); assert.equal(sent.length, 0, 'everything waits behind the lost segment');
  await until(() => sent.length === 3, 2000);
  assert.ok(performance.now() - t0 >= 75);
  assert.deepEqual(sent.map(d => JSON.parse(d).s), [1, 2, 3]); assert.ok(e.stats.impairedStalls >= 1);
  // without stallMs, loss still drops only datagrams: the WebSocket loses and stalls nothing
  const kept = [], f = new Endpoint({ impair: { loss: 1 } });
  f.attach(1, { open: true, bufferedAmount: 0, send: d => (kept.push(d), true), close() {} });
  for (let i = 0; i < 3; i++) f.sendEvent(i);
  await until(() => kept.length === 3, 500); assert.equal(f.stats.impairedStalls, 0);
  assert.throws(() => f.setImpairment({ stallMs: -1 })); assert.throws(() => f.setImpairment({ stallMs: 20000 }));
});

test('ICE server lists are validated; TURN REST credentials match coturn', () => {
  assert.ok(validIceServers([{ urls: 'stun:stun.l.google.com:19302' }, { urls: ['turn:t.example.com:3478?transport=udp', 'turns:t.example.com:443'], username: 'u', credential: 'c' }]));
  assert.ok(!validIceServers([{ urls: 'http://evil' }])); assert.ok(!validIceServers({ urls: 'stun:x' }));
  const c = turnCredentials({ secret: 's3cret', urls: 'turn:t.example.com:3478', user: 'wren', ttlSeconds: 600, now: 1_000_000_000_000 });
  assert.equal(c.username, '1000000600:wren');
  assert.equal(c.credential, createHmac('sha1', 's3cret').update('1000000600:wren').digest('base64'));
  assert.throws(() => turnCredentials({ secret: '', urls: 'turn:x' }));
});

test('Cloudflare TURN credentials are fetched once and cached', async () => {
  let calls = 0;
  const fake = async (url, init) => {
    calls++; assert.match(url, /keys\/KEY\/credentials\/generate-ice-servers$/); assert.equal(init.headers.Authorization, 'Bearer TOKEN');
    return { ok: true, json: async () => ({ iceServers: { urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'p' } }) };
  };
  const get = cloudflareTurn({ keyId: 'KEY', apiToken: 'TOKEN', fetch: fake });
  const [a, b] = await Promise.all([get(), get()]); const c = await get();
  assert.equal(calls, 1); assert.equal(a[0].username, 'u'); assert.equal(a, b); assert.equal(c, a);
});

async function serve(options = {}) {
  const server = await createGameServer({ origins: [], allowMissingOrigin: true, ...options });
  const port = await server.listen();
  return { server, url: `ws://127.0.0.1:${port}/connect` };
}
test('the server hands each client its ICE servers, and the client exposes them', async () => {
  const s = await serve({ iceServers: session => [turnCredentials({ secret: 'x', urls: 'turn:relay.example.com:3478', user: session.id.slice(0, 8) })] });
  const c = new GameClient({ url: s.url, room: 'ice', rtc: false });
  try {
    c.connect(); await c.whenOnline();
    assert.equal(c.iceServers.length, 1); assert.match(c.iceServers[0].username, /^\d+:[\w-]+$/);
    assert.equal(c.transport, 'ws');
  } finally { c.close(); await s.server.close(); }
});

test('whenOnline rejects when the session is lost; endSession kicks a client for good', async () => {
  const s = await serve(); const c = new GameClient({ url: s.url, room: 'kick', rtc: false, reconnectBaseMs: 10 });
  let lost;
  c.onSessionLost = info => lost = info;
  try {
    c.connect(); await c.whenOnline();
    s.server.endSession(s.server.sessions.get(c.id), 'kicked');
    await until(() => c.status === 'lost'); assert.equal(lost.reason, 'kicked');
    await assert.rejects(c.whenOnline(), /lost/); assert.equal(s.server.sessions.size, 0);
  } finally { c.close(); await s.server.close(); }
});

test('server impairment is only honoured when allowed; metrics count sessions and transports', async () => {
  for (const allow of [false, true]) {
    const s = await serve({ allowImpairment: allow }); const c = new GameClient({ url: s.url, room: 'imp', rtc: false, impair: { lagMs: 5 } });
    try {
      c.connect(); await c.whenOnline();
      const session = s.server.sessions.get(c.id);
      assert.equal(!!session.endpoint.impaired, allow);
      const m = s.server.metrics(); assert.equal(m.sessions, 1); assert.equal(m.ws, 1); assert.equal(m.rtc, 0);
    } finally { c.close(); await s.server.close(); }
  }
});

test('trustProxy reads the last X-Forwarded-For hop from a local proxy only', async () => {
  const s = await serve({ trustProxy: true });
  try {
    const req = (remote, xff) => ({ socket: { remoteAddress: remote }, headers: { 'x-forwarded-for': xff } });
    assert.equal(s.server.addressOf(req('127.0.0.1', '1.1.1.1, 203.0.113.9')), '203.0.113.9');
    assert.equal(s.server.addressOf(req('198.51.100.1', '203.0.113.9')), '198.51.100.1');
  } finally { await s.server.close(); }
});

test('a client resumes after the page comes back with a dead socket (wake check)', async () => {
  const s = await serve(); const c = new GameClient({ url: s.url, room: 'wake', rtc: false, reconnectBaseMs: 10 });
  try {
    c.connect(); await c.whenOnline(); const id = c.id;
    // simulate a socket that silently died while the phone slept: the server stops answering this connection
    const session = s.server.sessions.get(id); session.endpoint.detach();
    c['wakeDeadline'] = performance.now() + 50;
    await until(() => c.status === 'connecting', 2000); await c.whenOnline();
    assert.equal(c.id, id, 'same session after the wake reconnect');
  } finally { c.close(); await s.server.close(); }
});

test('snapshot deltas against the acknowledged baseline survive loss and rebuild the same world', async () => {
  const { SnapshotHistory, diffEntities, applyEntityDelta } = await import('../dist/netcode/index.js');
  const p = pair({ stateAckIntervalMs: 0 }), history = new SnapshotHistory(), receiverStates = new Map();
  p.a.onStateAck = (stream, seq) => history.acknowledge(seq);
  let world = {}, view = null, dropped = 0;
  p.b.onState = s => {
    const msg = JSON.parse(new TextDecoder().decode(s.data));
    const base = msg.b ? receiverStates.get(msg.b) : null;
    if (msg.b && !base) return; // never happens: the sender only uses acknowledged baselines
    view = applyEntityDelta(base, msg.d); receiverStates.set(s.seq, view);
  };
  for (let tick = 1; tick <= 60; tick++) {
    world = { ...world, ['e' + (tick % 7)]: { x: tick, hp: 10 - (tick % 3) } };
    if (tick % 11 === 0) { const { e1, ...rest } = world; world = rest; }
    const base = history.baseline;
    const seq = p.a.sendState(0, new TextEncoder().encode(JSON.stringify({ b: base?.seq ?? 0, d: diffEntities(base?.value ?? null, world) })), tick, { ack: true });
    history.record(seq, world);
    if (tick % 4 === 0) { p.a.flush(); p.reliable.length = 0; dropped++; } // this snapshot is lost
    p.advance();
  }
  { // the next snapshot after the last lost one repairs the view
    const base = history.baseline;
    history.record(p.a.sendState(0, new TextEncoder().encode(JSON.stringify({ b: base?.seq ?? 0, d: diffEntities(base?.value ?? null, world) })), 61, { ack: true }), world);
    p.advance(); p.advance();
  }
  assert.ok(dropped > 10); assert.deepEqual(view, world);
});

test('late states: dropped by default; delivered once with late: true when asked, acks following the newest', () => {
  const frame = (seq, kind = FrameKind.state) => encodeFrame({ kind, epoch: 1, stream: 3, seq, time: seq, payload: Uint8Array.of(seq) });
  for (const mode of ['drop', 'deliver']) {
    const e = new Endpoint({ lateStates: mode }), got = [];
    e.attach(1, { open: true, bufferedAmount: 0, send: () => true, close() {} });
    e.onState = s => got.push([s.seq, s.late]);
    for (const seq of [1, 4, 2, 3, 2, 40, 5, 39]) e.receiveBinary(frame(seq), 'ws');
    if (mode === 'drop') assert.deepEqual(got, [[1, false], [4, false], [40, false]]);
    else assert.deepEqual(got, [[1, false], [4, false], [2, true], [3, true], [40, false], [39, true]],
      'each unseen state once; 5 is over 32 behind 40');
  }
  let now = 0; const e = new Endpoint({ lateStates: 'deliver', now: () => now }), sent = [];
  e.attach(1, { open: true, bufferedAmount: 0, send: d => (sent.push(d), true), close() {} });
  e.receiveBinary(frame(10, FrameKind.stateAcked), 'ws'); e.receiveBinary(frame(8, FrameKind.stateAcked), 'ws');
  now = 100; e.pump(); const sack = sent.map(d => typeof d === 'string' ? null : decodeFrame(d)).find(f => f?.kind === FrameKind.sack);
  assert.ok(sack, 'a state ack went out');
  assert.equal(new DataView(sack.payload.buffer, sack.payload.byteOffset).getUint32(2, true), 10, 'the ack names the newest, not the late one');
});
