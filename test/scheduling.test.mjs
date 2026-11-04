import test from 'node:test';
import assert from 'node:assert/strict';
import { pair } from './helpers.mjs';
import { Endpoint } from '../dist/core/endpoint.js';
import { TrafficBudget } from '../dist/core/budget.js';

test('an oversized backlogged event spends its share instead of repeatedly losing refill credit to pump rounding', () => {
  const budget = new TrafficBudget(4000, 200, .075, 0);
  let events = 0;
  for (let now = 0; now < 60000; now += 10) {
    // The state class is busy: its positive credit must remain protected.
    if (budget.reserve('event', 680, now, Infinity)) events++;
    assert.ok(events * 680 <= now * 3.7 + 185 + 680, 'bounded one-packet debt must repay at the configured event rate');
  }
  assert.ok(events >= 325, `backlogged event class left earned bandwidth unused: ${events}`);
});

test('movement retains service under sustained ordered event load within the same byte budget', () => {
  const p = pair({ bytesPerSecond: 4000, burstBytes: 200 });
  let states = 0; const events = [];
  p.b.onState = () => states++;
  p.b.onEvent = (_, seq) => events.push(seq);
  for (let n = 0; n < 300; n++) {
    if (n % 5 === 0) p.a.sendState(1, new Uint8Array(8), p.now, { ttlMs: 40 });
    p.a.sendEvent({ n, data: 'x'.repeat(600) });
    p.advance(10);
  }
  assert.ok(states >= 55, `only ${states}/60 movement snapshots survived the event flood`);
  assert.ok(events.length >= 16, `unused state credit must serve reliable events too: ${events.length}`);
  assert.deepEqual(events, events.map((_, n) => n + 1));
  assert.ok(p.a.stats.bytesSent < 13500, 'fairness must not bypass the egress budget');
});

test('unsendable large candidates do not hide a smaller state behind the packet-per-flush limit', () => {
  const p = pair({ bytesPerSecond: 1000, burstBytes: 100 }); const seen = [];
  p.b.onState = state => seen.push(state.stream);
  p.a.sendState(0, new Uint8Array(60), p.now); p.a.flush(); p.deliver();
  for (let stream = 1; stream <= 8; stream++) p.a.sendState(stream, new Uint8Array(300), p.now, { priority: 10 });
  p.a.sendState(9, new Uint8Array(5), p.now, { priority: 1 }); p.a.flush(); p.deliver();
  assert.deepEqual(seen, [0, 9]);
});

test('a backpressured state does not spend tokens for bytes that were never sent', () => {
  const p = pair({ bytesPerSecond: 1000, burstBytes: 100 });
  p.blocked.bufferedA = 1e9;
  p.a.sendState(1, new Uint8Array(70), p.now);
  for (let n = 0; n < 4; n++) p.a.flush();
  p.blocked.bufferedA = 0; p.a.flush(); p.deliver();
  assert.equal(p.b.stats.statesReceived, 1);
});

test('a rejected reliable write does not consume the budget or advance ordered delivery', () => {
  let accept = false; const sent = [];
  const endpoint = new Endpoint({ now: () => 0, bytesPerSecond: 1000, burstBytes: 100 });
  endpoint.attach(1, { open: true, bufferedAmount: 0, close() {}, send(data) {
    if (!accept) return false; sent.push(data); return true;
  } });
  endpoint.sendEvent({ text: 'x'.repeat(60) });
  assert.equal(endpoint.events.sentThrough, 0);
  accept = true; endpoint.flush();
  assert.equal(sent.length, 1);
  assert.equal(endpoint.events.sentThrough, 1);
});
