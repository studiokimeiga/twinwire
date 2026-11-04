import test from 'node:test';
import assert from 'node:assert/strict';
import { Endpoint } from '../dist/core/endpoint.js';
import { readControl } from '../dist/core/protocol.js';

function network() {
  let now = 0; const pending = [], writes = [], blocked = new Set();
  const options = { now: () => now, probeIntervalMs: 20, probeTimeoutMs: 100, pathSwitchHoldMs: 100 };
  const a = new Endpoint(options), b = new Endpoint(options);
  for (const [from, to] of [[a,b], [b,a]]) from.attach(1, { open: true, bufferedAmount: 0, close() {},
    send(data) { pending.push({ to, data, via: 'ws' }); return true; } });
  const attach = via => {
    for (const [from, to] of [[a,b], [b,a]]) from.attachDatagram({ open: true, bufferedAmount: 0,
      maxMessageBytes: via === 'wt' ? 1200 : 8192 + 14, close() {},
      send(data) {
        writes.push({ from, via, bytes: data.length });
        if (!blocked.has(via + (from === a ? ':a' : ':b'))) pending.push({ to, data: data.slice(), via });
        return true;
      } }, via);
  };
  const deliver = () => {
    let turns = 0;
    while (pending.length) {
      assert.ok(++turns < 10_000);
      const { to, data, via } = pending.shift();
      if (typeof data === 'string') to.receiveControl(readControl(data)); else to.receiveBinary(data, via);
    }
  };
  return { a,b,attach,deliver,writes,blocked,
    advance(ms = 20) { now += ms; a.pump(); b.pump(); deliver(); }, get now() { return now; } };
}

test('WebTransport is proven independently and an MTU-sized path never receives an oversized state', () => {
  const n = network(); n.attach('wt');
  assert.equal(n.a.fastActive, false);
  n.advance(); assert.equal(n.a.fastTransport, 'wt');
  const received = []; n.b.onState = state => received.push(state);
  n.a.sendState(1, new Uint8Array(100), n.now); n.advance();
  n.a.sendState(2, new Uint8Array(3000), n.now); n.advance();
  assert.deepEqual(received.map(s => s.via), ['wt', 'ws']);
  assert.ok(n.writes.filter(w => w.via === 'wt').every(w => w.bytes <= 1200));
});

test('a healthy RTC path survives an unproven WebTransport attempt and a one-way WT outage falls back', () => {
  const n = network(); n.attach('rtc'); n.advance();
  assert.equal(n.a.fastTransport, 'rtc');
  n.attach('wt'); n.blocked.add('wt:b');
  for (let i = 0; i < 8; i++) n.advance();
  assert.equal(n.a.fastTransport, 'rtc');
  n.blocked.delete('wt:b'); n.attach('wt');
  for (let i = 0; i < 8; i++) n.advance();
  assert.equal(n.a.fastTransport, 'wt');
  n.blocked.add('wt:b');
  for (let i = 0; i < 8; i++) n.advance();
  assert.equal(n.a.fastTransport, 'rtc');
  assert.equal(n.a.connectionEpoch, 1);
  const events = []; n.b.onEvent = (_, seq) => events.push(seq);
  n.a.sendEvent({ fire: 1 }); n.advance();
  assert.deepEqual(events, [1]);
});

test('dropping one fast path retains the other, while detach retires every path', () => {
  const n = network(); n.attach('rtc'); n.attach('wt');
  for (let i = 0; i < 7; i++) n.advance();
  n.a.dropDatagram(false, 'wt');
  assert.equal(n.a.fastTransport, 'rtc');
  n.a.detach(); assert.equal(n.a.fastActive, false); assert.equal(n.a.active, false);
});
