import test from 'node:test';
import assert from 'node:assert/strict';
import { SubtickInputBuffer, replaySubtick, Timeline, Predictor, InputInbox } from '../dist/netcode/index.js';
import { ReliableEvents } from '../dist/index.js';

test('netcode and event checkpoint defaults work without structuredClone (Safari 15.0-15.3)', () => {
  const native = globalThis.structuredClone;
  try {
    globalThis.structuredClone = undefined;
    const inputs = new SubtickInputBuffer();
    const initial = { button: 1 };
    inputs.push(2, initial);
    initial.button = 90;
    const collected = inputs.take(0, 10);
    assert.deepEqual(collected, [{ fraction: .2, value: { button: 1 } }]);

    const transitions = [{ fraction: .25, value: { x: 1 } }, { fraction: .75, value: { x: 2 } }];
    const trace = [];
    const final = replaySubtick({ x: 0 }, transitions, 16,
      (held, dt) => trace.push([held.x, dt]),
      (_, __, fraction) => { if (fraction === .25) transitions[1].value.x = 999; });
    assert.deepEqual(trace.map(s => s[0]), [0, 1, 2]);
    assert.deepEqual(final, { x: 2 });

    const timeline = new Timeline();
    const sample = { x: 1 };
    timeline.insert({ seq: 1, time: 0, value: sample });
    sample.x = 999;
    timeline.insert({ seq: 2, time: 10, value: { x: 3 } });
    assert.deepEqual(timeline.sample(5, (a, b, t) => ({ x: a.x + (b.x - a.x) * t })).value, { x: 2 });

    const predictor = new Predictor({ x: 0 }, (s, i) => ({ x: s.x + i.dx }), 1);
    const input = { dx: 2 };
    predictor.push(input);
    input.dx = 500;
    assert.equal(predictor.state.x, 2);
    predictor.push({ dx: 3 });
    predictor.reconcile({ ack: 1, tick: 1, state: { x: 2 } });
    assert.equal(predictor.state.x, 5);
    assert.equal(predictor.pendingCount, 1);
    assert.deepEqual(predictor.recent(1)[0].value, { dx: 3 });

    const inbox = new InputInbox();
    const raw = { pressed: 7 };
    assert.equal(inbox.add({ seq: 1, value: raw }), true);
    raw.pressed = 10;
    assert.deepEqual(inbox.next(), { seq: 1, value: { pressed: 7 } });

    const events = new ReliableEvents();
    events.push({ type: 'action', data: { n: 1 } });
    const saved = events.checkpoint();
    assert.deepEqual(saved.pending[0].data, { type: 'action', data: { n: 1 } });
    saved.pending[0].data.data.n = 99;
    assert.equal(events.checkpoint().pending[0].data.data.n, 1);
  } finally {
    globalThis.structuredClone = native;
  }
});

test('Safari fallback preserves structured input types, cycles, shared buffers and special values', () => {
  const native = globalThis.structuredClone;
  try {
    globalThis.structuredClone = undefined;
    const buffer = new Float32Array([1.5, 2.5]);
    const key = { id: 1 };
    const m = new Map([[key, new Set([key])]]);
    const original = {
      bytes: buffer, view: new DataView(buffer.buffer), backing: buffer.buffer,
      date: new Date('2026-11-01T00:00:00Z'), re: /bar/gi,
      missing: undefined, notANumber: NaN, positiveInfinity: Infinity, big: 123n, map: m,
      sparse: new Array(3), optional: null,
    };
    original.self = original;
    const q = new SubtickInputBuffer();
    q.push(1, original);
    const copy = q.take(0, 2)[0].value;
    assert.notEqual(copy, original);
    assert.equal(copy.self, copy);
    assert.ok(copy.bytes instanceof Float32Array);
    assert.deepEqual([...copy.bytes], [1.5, 2.5]);
    assert.notEqual(copy.backing, original.backing);
    assert.equal(copy.bytes.buffer, copy.backing);
    assert.equal(copy.view.buffer, copy.backing);
    assert.equal(copy.view.byteLength, 8);
    assert.equal(copy.date.getTime(), original.date.getTime());
    assert.equal(copy.re.source, 'bar');
    assert.equal(copy.re.flags, 'gi');
    assert.equal(Object.hasOwn(copy, 'missing'), true);
    assert.equal(copy.missing, undefined);
    assert.ok(Number.isNaN(copy.notANumber));
    assert.equal(copy.positiveInfinity, Infinity);
    assert.equal(copy.big, 123n);
    assert.equal(copy.sparse.length, 3);
    assert.equal(0 in copy.sparse, false);
    const cloneKey = [...copy.map.keys()][0];
    assert.notEqual(cloneKey, key);
    assert.equal([...copy.map.values()][0].has(cloneKey), true);

    const property = JSON.parse('{"__proto__":{"polluted":true}}');
    q.reset(); q.push(1, property);
    const safe = q.take(0, 2)[0].value;
    assert.equal(Object.getPrototypeOf(safe), Object.prototype);
    assert.equal(Object.hasOwn(safe, '__proto__'), true);
    assert.equal({}.polluted, undefined);
  } finally { globalThis.structuredClone = native; }
});

test('Safari fallback rejects unsupported input types without corrupting buffers', () => {
  const native = globalThis.structuredClone;
  try {
    globalThis.structuredClone = undefined;
    const q = new SubtickInputBuffer();
    assert.throws(() => q.push(1, { callback: () => 1 }), /cloneable/);
    assert.throws(() => q.push(1, new (class State { x = 1; })()), /Unsupported input object/);
    assert.throws(() => q.push(1, Symbol('bad')), /cloneable/);
    assert.equal(q.pending, 0);
    q.push(1, { button: 1 });
    assert.equal(q.take(0, 2).length, 1);

    let calls = 0;
    const bad = [{ fraction: .2, value: { button: 1 } }, { fraction: .7, value: { callback: () => 1 } }];
    assert.throws(() => replaySubtick({ button: 0 }, bad, 16, () => calls++), /cloneable/);
    assert.equal(calls, 0);
  } finally { globalThis.structuredClone = native; }
});
