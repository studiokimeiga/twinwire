import test from 'node:test';
import assert from 'node:assert/strict';
import { pair } from './helpers.mjs';
import * as api from '../dist/client/index.js';
import { StateReceiver } from '../dist/client/state.js';
import { AdaptivePlayback } from '../dist/netcode/interpolation.js';

test('state diagnostics measure the real enqueue, send and receive boundaries without payloads', () => {
  const trace = [];
  const p = pair({ trace: event => trace.push(event) });
  const seq = p.a.sendState(1, new Uint8Array([42]), 0);
  p.advance(20);
  assert.deepEqual(trace.map(e => e.stage), ['queued', 'sent', 'received']);
  assert.equal(trace[1].queueMs, 20);
  assert.equal(trace[1].seq, seq);
  assert.equal(trace[2].sourceTimeMs, 0);
  assert.equal(trace[2].via, 'ws');
  assert.ok(trace.every(e => !('data' in e) && !('payload' in e)));
});

test('a throwing diagnostics observer cannot change delivery or acknowledgement', () => {
  const p = pair({ trace: () => { throw new Error('observer'); } });
  let received = 0;
  p.b.onState = () => received++;
  p.a.sendState(1, new Uint8Array([1]), 0, { ack: true });
  p.advance(20); p.advance(60);
  assert.equal(received, 1);
  assert.equal(p.a.stateAck(1), 1);
  assert.ok(p.a.stats.traceErrors > 0);
});

test('coalesced payload age is distinct from time waiting for a stream to get service', () => {
  const trace = []; const p = pair({ trace: e => trace.push(e) });
  p.blocked.bufferedA = 1e9;
  p.a.sendState(1, new Uint8Array([1]), 0);
  p.advance(20);
  p.a.sendState(1, new Uint8Array([2]), 20);
  p.blocked.bufferedA = 0; p.advance(5);
  assert.equal(trace.find(e => e.stage === 'sent').queueMs, 5);
  assert.equal(trace.filter(e => e.reason === 'coalesced').length, 1);
});

test('trace recorder stays bounded, orders its ring and excludes extra private fields', () => {
  assert.equal(typeof api.StateTraceBuffer, 'function');
  const buffer = new api.StateTraceBuffer(2);
  for (let seq = 1; seq <= 3; seq++) buffer.record({ stage: 'sent', seq, stream: 1, epoch: 2,
    localTimeMs: seq, sourceTimeMs: 0, bytes: 1, queueMs: seq, data: new Uint8Array([9]), token: 'secret' });
  assert.deepEqual(buffer.snapshot().map(e => e.seq), [2, 3]);
  assert.equal(buffer.overwritten, 1);
  assert.equal('token' in buffer.snapshot()[0], false);
  assert.equal('data' in buffer.snapshot()[0], false);
  buffer.snapshot()[0].seq = 999;
  assert.equal(buffer.snapshot()[0].seq, 2);
  assert.equal(buffer.summary().queueMs.p99, 3);
  buffer.clear(); assert.equal(buffer.snapshot().length, 0);
  assert.throws(() => new api.StateTraceBuffer(Infinity), RangeError);
});

test('application, playback and render marks expose separate ages and stop after disconnect', () => {
  let now = 100, online = true; const trace = [];
  const receiver = new StateReceiver({ connected: () => online, generation: () => 1,
    now: () => now, tolerance: () => 1, remove() {}, trace: (stage, state, details) => trace.push({ stage, state, ...details }) },
    { stream: 1, apply: () => true, playback: new AdaptivePlayback(20) });
  receiver.receive({ stream: 1, seq: 1, time: 80, data: new Uint8Array([7]), via: 'ws' });
  assert.equal(trace[0]?.stage, 'applied');
  now = 110; receiver.advance(10);
  assert.equal(trace.at(-1).stage, 'playback');
  assert.ok(trace.at(-1).playbackDelayMs >= 20);
  receiver.markRendered(75);
  assert.equal(trace.at(-1).stage, 'rendered');
  assert.equal(trace.at(-1).state.time, 75);
  assert.equal('data' in trace.at(-1).state, false);
  online = false; receiver.disconnect();
  const count = trace.length; receiver.markRendered(); receiver.advance(10);
  assert.equal(trace.length, count);
});
