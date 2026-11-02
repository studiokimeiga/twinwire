import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createGameServer } from '../dist/server/index.js';
import { GameClient } from '../dist/client/index.js';
import { until, sleep } from './helpers.mjs';
import {
  PROFILES, TICK_MS, tickStartFor, runTrial, runMatrix, makeHistory,
  makeFireTransitions, adjudicateShot,
} from '../tools/fps-lab.mjs';

const history = makeHistory();
const adjudicate = (overrides = {}) => adjudicateShot({
  role: 'holder', arrivalMs: 700, commandTickStartMs: tickStartFor(675),
  expectedViewTimeMs: 600, requestedViewTimeMs: 600,
  history, transitions: makeFireTransitions(675), ...overrides,
});

test('seeded network matrix is repeatable and peeker delay grows with downlink delay', () => {
  const one = runMatrix({ trials: 64, seed: 1337 });
  const two = runMatrix({ trials: 64, seed: 1337 });
  assert.deepEqual(one, two);
  assert.equal(one.length, PROFILES.length);
  assert.deepEqual(one.slice(0, 4).map(p => p.rttMs), [0, 50, 100, 200]);
  assert.ok(one[0].peekerAdvantageMedianMs > 0);
  assert.ok(one[3].peekerAdvantageMedianMs > one[0].peekerAdvantageMedianMs);
  assert.ok(one[4].peekerAdvantageMedianMs > one[5].peekerAdvantageMedianMs);
  assert.ok(one.find(p => p.name === 'jitter-loss-stress').fallbackRate > 0);
  assert.equal(one.find(p => p.name === 'rewind-cap-300').rejectRate, 1);
  for (const p of one) {
    assert.ok(p.shots > 0);
    assert.ok(p.hitRate >= 0 && p.hitRate <= 1);
    assert.ok(p.rejectRate >= 0 && p.rejectRate <= 1);
    assert.ok(p.fallbackRate >= 0 && p.fallbackRate <= 1);
  }
});

test('snapshot loss affects visibility; it never silently drops reliable shots', () => {
  const noSnapshots = runTrial({
    name: 'no-snapshots', upMs: 10, downMs: 10, jitterMs: 0, snapshotLoss: 1,
  });
  assert.equal(noSnapshots.deliveredSnapshots, 0);
  assert.equal(noSnapshots.holder, null);
  assert.equal(noSnapshots.peeker, null);
  const clean = runTrial(PROFILES[0]);
  assert.equal(clean.peeker.result, 'hit');
  assert.equal(clean.holder.result, 'hit');
});

test('server-owned history, input age and rewind estimate control shot outcomes', () => {
  const valid = adjudicate();
  assert.equal(valid.result, 'hit');
  assert.equal(valid.source, 'client');
  assert.equal(valid.timeMs, 600);

  const forged = adjudicate({
    arrivalMs: 900, commandTickStartMs: tickStartFor(875),
    expectedViewTimeMs: 800, requestedViewTimeMs: 600,
    transitions: makeFireTransitions(875),
  });
  assert.equal(forged.source, 'server');
  assert.equal(forged.timeMs, 800);
  assert.equal(forged.result, 'miss', 'a forged old view cannot hit a target now behind cover');

  const stale = adjudicate({
    arrivalMs: 900, commandTickStartMs: tickStartFor(875), expectedViewTimeMs: 600,
    transitions: makeFireTransitions(875),
  });
  assert.equal(stale.result, 'rejected');
  assert.equal(stale.reason, 'expected-outside-window');
  assert.equal(stale.timeMs, null);

  const oldInput = adjudicate({
    commandTickStartMs: tickStartFor(400), transitions: makeFireTransitions(400),
  });
  assert.equal(oldInput.result, 'rejected');
  assert.equal(oldInput.reason, 'input-outside-window');
  assert.equal(adjudicate({ transitions: [{ fraction: 1, value: { fire: true } }] }).reason, 'invalid-subtick');
  assert.equal(adjudicate({ transitions: [{ fraction: .25, value: { fire: false } }] }).reason, 'invalid-fire-edges');
  assert.equal(adjudicate({ aimY: 3 }).result, 'miss');
});

test('sub-tick press fraction changes a shot at the same tick origin from cover to exposure', () => {
  const commandTickStartMs = tickStartFor(450); // exposure boundary is inside this tick
  const fireAt = timeMs => adjudicateShot({
    role: 'peeker', arrivalMs: 470, commandTickStartMs,
    requestedViewTimeMs: 440, expectedViewTimeMs: 440, history,
    transitions: [{
      fraction: (timeMs - commandTickStartMs) / TICK_MS, value: { fire: true },
    }],
  });
  const covered = fireAt(449), exposed = fireAt(451);
  assert.equal(covered.result, 'miss');
  assert.equal(exposed.result, 'hit');
  assert.ok(Math.abs(covered.shotAtMs - 449) < 1e-10);
  assert.ok(Math.abs(exposed.shotAtMs - 451) < 1e-10);
  assert.equal(covered.timeMs, exposed.timeMs, 'the historical view time remains unchanged');
});

// WebSocket loopback integration: inject real per-direction delay and seeded
// jitter in the socket adapter. Virtual world/rewind timestamps remain server
// owned so CI scheduling variance cannot change the authoritative verdict.
// Packet loss is covered by the synthetic snapshot model above, not by
// dropping reliable WebSocket frames (which would violate the WS protocol).
class DelayedSocket {
  constructor(url, profile, createSocket = u => new WebSocket(u)) {
    this.upMs = profile.upMs;
    this.downMs = profile.downMs;
    this.jitterMs = profile.jitterMs;
    this.seed = 0x1da757;
    this.closed = false;
    this.outbound = { queue: [], timer: null, scheduledThrough: 0 };
    this.inbound = { queue: [], timer: null, scheduledThrough: 0 };
    this.raw = createSocket(url);
    this.raw.binaryType = 'arraybuffer';
    this.raw.onopen = e => { if (!this.closed) this.onopen?.(e); };
    this.raw.onclose = e => {
      this.closed = true;
      this.clearPending();
      this.onclose?.(e);
    };
    this.raw.onerror = e => { if (!this.closed) this.onerror?.(e); };
    this.raw.onmessage = e => {
      const data = e.data;
      this.enqueue(this.inbound, this.downMs, () => this.onmessage?.({ data }));
    };
  }
  delay(base) {
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x >>> 0;
    return Math.max(0, Math.round(base + (this.seed / 4294967296 * 2 - 1) * this.jitterMs));
  }
  // Model variable per-frame latency without inventing out-of-order TCP/WS frames.
  // One scheduled callback per direction drains its queue in arrival order.
  enqueue(lane, baseMs, deliver) {
    if (this.closed) return;
    const due = Math.max(performance.now() + this.delay(baseMs), lane.scheduledThrough);
    lane.scheduledThrough = due;
    lane.queue.push({ due, deliver });
    this.drain(lane);
  }
  drain(lane) {
    if (this.closed || lane.timer !== null || !lane.queue.length) return;
    lane.timer = setTimeout(() => {
      lane.timer = null;
      const next = lane.queue.shift();
      if (!this.closed && this.raw.readyState === WebSocket.OPEN) next.deliver();
      this.drain(lane);
    }, Math.max(0, lane.queue[0].due - performance.now()));
  }
  clearPending() {
    for (const lane of [this.outbound, this.inbound]) {
      if (lane.timer !== null) clearTimeout(lane.timer);
      lane.timer = null;
      lane.queue.length = 0;
      lane.scheduledThrough = 0;
    }
  }
  get readyState() { return this.raw.readyState; }
  get bufferedAmount() { return this.raw.bufferedAmount; }
  set binaryType(value) { this.raw.binaryType = value; }
  get binaryType() { return this.raw.binaryType; }
  send(data) {
    this.enqueue(this.outbound, this.upMs, () => this.raw.send(data));
  }
  close(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.clearPending();
    this.raw.close(code, reason);
  }
}

// A transport fake isolates the impairment adapter's ordering from the server.
class FakeWebSocket {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent = [];
  send(data) { this.sent.push(data); }
  emit(data) { this.onmessage?.({ data }); }
  close() {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: '' });
  }
}
test('jittered outgoing and incoming WebSocket bursts remain FIFO', async () => {
  const raw = new FakeWebSocket();
  const socket = new DelayedSocket('ignored', { upMs: 20, downMs: 20, jitterMs: 20 }, () => raw);
  const received = [];
  socket.onmessage = event => received.push(event.data);
  const expected = Array.from({ length: 32 }, (_, i) => i);
  try {
    for (const value of expected) {
      socket.send(value);
      raw.emit(value);
    }
    await until(() => raw.sent.length === expected.length && received.length === expected.length, 3000);
    assert.deepEqual(raw.sent, expected, 'client to server preserves byte-stream order');
    assert.deepEqual(received, expected, 'server to client preserves byte-stream order');
  } finally { socket.close(); }
});
test('closing a delayed WebSocket cancels queued sends and receives', async () => {
  const raw = new FakeWebSocket();
  const socket = new DelayedSocket('ignored', { upMs: 150, downMs: 150, jitterMs: 10 }, () => raw);
  const received = [];
  socket.onmessage = event => received.push(event.data);
  socket.send('stale');
  raw.emit('stale');
  socket.close();
  await sleep(200);
  assert.deepEqual(raw.sent, []);
  assert.deepEqual(received, []);
});

test('two real Twinwire clients exchange snapshots, fire inputs, and receive server-authoritative verdicts', async () => {
  const errors = [], seats = [];
  const game = { nowMs: 700, expectedViewTimeMs: 600, fireAtMs: 675,
    commandTickStartMs: tickStartFor(675) };
  const server = await createGameServer({
    origins: ['http://localhost'], allowMissingOrigin: true,
    onError: e => errors.push(e.message),
    onSession: session => {
      const role = seats.length === 0 ? 'peeker' : 'holder';
      seats.push({ role, session });
      session.onEvent = command => {
        if (!command || command.type !== 'shot') return;
        const verdict = adjudicateShot({
          role, arrivalMs: game.nowMs, commandTickStartMs: game.commandTickStartMs,
          expectedViewTimeMs: game.expectedViewTimeMs,
          requestedViewTimeMs: command.requestedViewTimeMs,
          transitions: command.transitions, history,
        });
        session.sendEvent({ type: 'verdict', seq: command.seq, verdict });
        session.flush();
      };
    },
  });
  const port = await server.listen();
  const url = 'ws://127.0.0.1:' + port + '/connect';
  const profile = { upMs: 20, downMs: 80, jitterMs: 4 };
  const clients = [];
  const resultMap = new Map(), snapshotMap = new Map();
  const makeClient = role => {
    const client = new GameClient({
      url, room: 'fps-lab', rtc: false, syncPings: 0,
      websocket: u => new DelayedSocket(u, profile),
    });
    client.onEvent = e => {
      if (e.type === 'verdict') resultMap.set(role + ':' + e.seq, e.verdict);
    };
    client.onState = st => snapshotMap.set(role,
      JSON.parse(new TextDecoder().decode(st.data)));
    clients.push(client);
    return client;
  };
  try {
    const peeker = makeClient('peeker');
    peeker.connect();
    await until(() => peeker.status === 'online' && seats.length === 1, 5000);
    const holder = makeClient('holder');
    holder.connect();
    await until(() => holder.status === 'online' && seats.length === 2, 5000);
    assert.deepEqual(seats.map(s => s.role), ['peeker', 'holder']);

    const sendSnapshot = (seat, timestamp) => {
      seat.session.sendState(0, new TextEncoder().encode(JSON.stringify({
        serverTimeMs: timestamp, peekerX: 1, holderX: 5,
      })), { ttlMs: 500 });
      seat.session.flush();
    };
    sendSnapshot(seats[1], 600);
    await until(() => snapshotMap.get('holder')?.serverTimeMs === 600, 5000);

    const fire = async (client, role, seq, requestedViewTimeMs) => {
      client.sendEvent({
        type: 'shot', seq, requestedViewTimeMs,
        transitions: makeFireTransitions(game.fireAtMs),
      });
      await until(() => resultMap.has(role + ':' + seq), 5000);
      return resultMap.get(role + ':' + seq);
    };
    assert.equal((await fire(holder, 'holder', 1, snapshotMap.get('holder').serverTimeMs)).result, 'hit');
    assert.equal((await fire(peeker, 'peeker', 1, 600)).result, 'hit');

    // Client tries to hit the peeker in a past exposed position after retreat.
    game.nowMs = 900; game.expectedViewTimeMs = 800;
    game.fireAtMs = 875; game.commandTickStartMs = tickStartFor(875);
    const forged = await fire(holder, 'holder', 2, 600);
    assert.equal(forged.source, 'server');
    assert.equal(forged.timeMs, 800);
    assert.equal(forged.result, 'miss');

    // Even the server's estimate is now too old for its history cap.
    game.expectedViewTimeMs = 600;
    const stale = await fire(holder, 'holder', 3, 600);
    assert.equal(stale.result, 'rejected');
    assert.equal(stale.reason, 'expected-outside-window');
    assert.equal(stale.timeMs, null);
    assert.deepEqual(errors, []);
  } finally {
    for (const c of clients) c.close();
    await server.close();
  }
});
