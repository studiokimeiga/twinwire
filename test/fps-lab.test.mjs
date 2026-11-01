import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createGameServer } from '../dist/server/index.js';
import { GameClient } from '../dist/client/index.js';
import { until } from './helpers.mjs';
import {
  PROFILES, runTrial, runMatrix, makeHistory, makeFireTransitions, adjudicateShot,
} from '../tools/fps-lab.mjs';

const history = makeHistory();
const adjudicate = (overrides = {}) => adjudicateShot({
  role: 'holder', arrivalMs: 700, firedAtServerMs: 675,
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
    arrivalMs: 900, firedAtServerMs: 875,
    expectedViewTimeMs: 800, requestedViewTimeMs: 600,
    transitions: makeFireTransitions(875),
  });
  assert.equal(forged.source, 'server');
  assert.equal(forged.timeMs, 800);
  assert.equal(forged.result, 'miss', 'a forged old view cannot hit a target now behind cover');

  const stale = adjudicate({
    arrivalMs: 900, firedAtServerMs: 875, expectedViewTimeMs: 600,
    transitions: makeFireTransitions(875),
  });
  assert.equal(stale.result, 'rejected');
  assert.equal(stale.reason, 'expected-outside-window');
  assert.equal(stale.timeMs, null);

  const oldInput = adjudicate({ firedAtServerMs: 400 });
  assert.equal(oldInput.result, 'rejected');
  assert.equal(oldInput.reason, 'input-outside-window');
  assert.equal(adjudicate({ transitions: [{ fraction: 1, value: { fire: true } }] }).reason, 'invalid-subtick');
  assert.equal(adjudicate({ transitions: [{ fraction: .25, value: { fire: false } }] }).reason, 'invalid-fire-edges');
  assert.equal(adjudicate({ aimY: 3 }).result, 'miss');
});

// WebSocket loopback integration: inject real per-direction delay and seeded
// jitter in the socket adapter. Virtual world/rewind timestamps remain server
// owned so CI scheduling variance cannot change the authoritative verdict.
// Packet loss is covered by the synthetic snapshot model above, not by
// dropping reliable WebSocket frames (which would violate the WS protocol).
class DelayedSocket {
  constructor(url, profile) {
    this.upMs = profile.upMs;
    this.downMs = profile.downMs;
    this.jitterMs = profile.jitterMs;
    this.seed = 0x1da757;
    this.raw = new WebSocket(url);
    this.raw.binaryType = 'arraybuffer';
    this.raw.onopen = e => this.onopen?.(e);
    this.raw.onclose = e => this.onclose?.(e);
    this.raw.onerror = e => this.onerror?.(e);
    this.raw.onmessage = e => {
      const data = e.data;
      setTimeout(() => this.onmessage?.({ data }), this.delay(this.downMs));
    };
  }
  delay(base) {
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x >>> 0;
    return Math.max(0, Math.round(base + (this.seed / 4294967296 * 2 - 1) * this.jitterMs));
  }
  get readyState() { return this.raw.readyState; }
  get bufferedAmount() { return this.raw.bufferedAmount; }
  set binaryType(value) { this.raw.binaryType = value; }
  get binaryType() { return this.raw.binaryType; }
  send(data) {
    setTimeout(() => {
      if (this.raw.readyState === WebSocket.OPEN) this.raw.send(data);
    }, this.delay(this.upMs));
  }
  close(code, reason) { this.raw.close(code, reason); }
}

test('two real Twinwire clients exchange snapshots, fire inputs, and receive server-authoritative verdicts', async () => {
  const errors = [], seats = [];
  const game = { nowMs: 700, expectedViewTimeMs: 600, firedAtServerMs: 675 };
  const server = await createGameServer({
    origins: ['http://localhost'], allowMissingOrigin: true,
    onError: e => errors.push(e.message),
    onSession: session => {
      const role = seats.length === 0 ? 'peeker' : 'holder';
      seats.push({ role, session });
      session.onEvent = command => {
        if (!command || command.type !== 'shot') return;
        const verdict = adjudicateShot({
          role, arrivalMs: game.nowMs, firedAtServerMs: game.firedAtServerMs,
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
        transitions: makeFireTransitions(game.firedAtServerMs),
      });
      await until(() => resultMap.has(role + ':' + seq), 5000);
      return resultMap.get(role + ':' + seq);
    };
    assert.equal((await fire(holder, 'holder', 1, snapshotMap.get('holder').serverTimeMs)).result, 'hit');
    assert.equal((await fire(peeker, 'peeker', 1, 600)).result, 'hit');

    // Client tries to hit the peeker in a past exposed position after retreat.
    game.nowMs = 900; game.expectedViewTimeMs = 800; game.firedAtServerMs = 875;
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
