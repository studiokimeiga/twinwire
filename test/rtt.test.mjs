import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createGameServer } from '../dist/server/index.js';
import { SocketSessionServer } from '../dist/worker.js';
import { GameClient } from '../dist/client/index.js';
import { GameSession } from '../dist/core/session.js';
import { until, sleep } from './helpers.mjs';

// A fixed delay each way, in order (a WebSocket never reorders frames). `drop` filters frames
// the client receives, to play a client from before server probes.
class DelayedSocket {
  constructor(url, { delayMs = 0, drop = () => false, origin } = {}) {
    this.delayMs = delayMs; this.drop = drop; this.closed = false;
    this.queues = { up: [], down: [] };
    this.raw = new WebSocket(url, origin ? { origin } : undefined); this.raw.binaryType = 'arraybuffer';
    this.raw.onopen = e => this.onopen?.(e);
    this.raw.onclose = e => { this.closed = true; this.onclose?.(e); };
    this.raw.onerror = e => this.onerror?.(e);
    this.raw.onmessage = e => { if (!this.drop(e.data)) this.later(() => this.onmessage?.({ data: e.data }), 'down'); };
  }
  later(f, direction = 'up') {
    const queue = this.queues[direction];
    queue.push({ at: performance.now() + this.delayMs, f });
    if (queue.length > 1) return;
    const deliver = () => {
      if (this.closed || this.raw.readyState !== WebSocket.OPEN) { queue.length = 0; return; }
      const remaining = queue[0].at - performance.now();
      // A JS timeout may wake before its nominal duration. Honour the injected minimum, in order,
      // instead of allowing an early timer to masquerade as an impossibly fast RTT measurement.
      if (remaining > 0) { setTimeout(deliver, Math.ceil(remaining)); return; }
      queue.shift().f();
      if (queue.length) deliver();
    };
    setTimeout(deliver, this.delayMs);
  }
  get readyState() { return this.raw.readyState; }
  get bufferedAmount() { return this.raw.bufferedAmount; }
  set binaryType(v) { this.raw.binaryType = v; }
  get binaryType() { return this.raw.binaryType; }
  send(data) { this.later(() => this.raw.send(data)); }
  close(code, reason) { this.closed = true; this.raw.close(code, reason); }
}
const isProbe = data => typeof data === 'string' && data.includes('"t":"probe"');

async function nodeServer(options) {
  let session;
  const server = await createGameServer({ origins: [], allowMissingOrigin: true, onSession: s => { session = s; }, ...options });
  const url = `ws://127.0.0.1:${await server.listen()}/connect`;
  return { url, get session() { return session; }, close: () => server.close() };
}

test('the server measures each client\'s round trip with its own probes, close to the real delay', async () => {
  const s = await nodeServer({ probeMs: 100 });
  const c = new GameClient({ url: s.url, room: 'rtt', rtc: false, websocket: u => new DelayedSocket(u, { delayMs: 30 }) });
  try {
    c.connect(); await until(() => c.status === 'online' && s.session);
    assert.equal(s.session.rttMs, null, 'nothing measured before the first answered probe');
    await until(() => s.session.minRttMs !== null, 3000); await sleep(800);
    const { rttMs, minRttMs } = s.session;
    assert.ok(minRttMs >= 59, `no faster than the 60 ms path: ${minRttMs}`);
    assert.ok(rttMs >= minRttMs && rttMs < 160, `smoothed round trip near the path: ${rttMs}`);
  } finally { c.close(); await s.close(); }
});

test('a client from before probes leaves rttMs null and its session healthy; probeMs 0 sends none', async () => {
  for (const probeMs of [50, 0]) {
    const s = await nodeServer({ probeMs }); let probes = 0;
    const c = new GameClient({ url: s.url, room: 'rtt', rtc: false, websocket: u => new DelayedSocket(u, { drop: d => isProbe(d) && ++probes > 0 }) });
    const echoes = []; c.onEvent = d => echoes.push(d);
    try {
      c.connect(); await until(() => c.status === 'online' && s.session);
      s.session.onEvent = d => s.session.sendEvent(d);
      await sleep(600); c.sendEvent({ n: 1 }); await until(() => echoes.length === 1);
      assert.equal(s.session.rttMs, null); assert.equal(s.session.connected, true);
      if (probeMs) assert.ok(probes >= 5 && probes <= 16, `one probe per interval, not a flood: ${probes}`);
      else assert.equal(probes, 0, 'probeMs 0 turns probes off');
    } finally { c.close(); await s.close(); }
  }
});

test('the Worker host measures round trips the same way', async () => {
  let session;
  const host = new SocketSessionServer({ origins: ['http://game.test'], probeMs: 100, onSession: s => { session = s; } });
  const httpServer = http.createServer(), wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => host.accept(ws, { origin: req.headers.origin ?? '', ip: 'test' })));
  await new Promise(r => httpServer.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${httpServer.address().port}/connect`;
  const c = new GameClient({ url, room: 'rtt', rtc: false, websocket: u => new DelayedSocket(u, { delayMs: 20, origin: 'http://game.test' }) });
  try {
    c.connect(); await until(() => c.status === 'online' && session);
    await until(() => session.minRttMs !== null, 3000);
    assert.ok(session.minRttMs >= 39 && session.rttMs < 140, `${session.minRttMs} / ${session.rttMs}`);
  } finally { c.close(); host.close(); wss.close(); await new Promise(r => httpServer.close(r)); }
});

test('probe bookkeeping: one outstanding probe, wrong or late echoes ignored, smoothing, reset per connection', () => {
  const s = new GameSession('id', 'room', null);
  assert.equal(s.nextProbe(0, 0), null, 'interval 0 is off');
  assert.equal(s.nextProbe(1000, 2000), 1); assert.equal(s.nextProbe(1500, 2000), null, 'not due yet');
  assert.equal(s.probeAnswered(2, 1050), false, 'another probe number');
  assert.equal(s.probeAnswered(1, 1080), true); assert.equal(s.rttMs, 80); assert.equal(s.minRttMs, 80);
  assert.equal(s.probeAnswered(1, 1090), false, 'answered once');
  assert.equal(s.nextProbe(3000, 2000), 2); assert.equal(s.probeAnswered(2, 3040), true);
  assert.equal(s.rttMs, 70, 'smoothed 1/4 toward the new sample'); assert.equal(s.minRttMs, 40);
  assert.equal(s.nextProbe(5000, 2000), 3); assert.equal(s.nextProbe(7000, 2000), 4, 'an unanswered probe is replaced');
  assert.equal(s.probeAnswered(3, 7010), false, 'the replaced one no longer counts');
  s.resetRtt(); assert.equal(s.rttMs, null); assert.equal(s.minRttMs, null); assert.equal(s.probeAnswered(4, 7020), false);
  assert.equal(s.nextProbe(7021, 2000), 5, 'a new connection probes at once');
});
