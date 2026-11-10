import test from 'node:test';
import assert from 'node:assert/strict';
import { SubtickInputBuffer, replaySubtick, selectRewindTime } from '../dist/netcode/index.js';

test('subtick press and release within one tick preserve both edges and movement durations', () => {
  const hz = 64, dt = 1000 / hz;
  const input = new SubtickInputBuffer();
  input.push(100 + dt * .2, 1);
  input.push(100 + dt * .7, 0);
  const events = input.take(100, 100 + dt);
  assert.deepEqual(events.map(e => e.value), [1,0]);
  assert.ok(Math.abs(events[0].fraction - .2) < 1e-12);
  assert.ok(Math.abs(events[1].fraction - .7) < 1e-12);
  const segments = [], edges = [];
  const final = replaySubtick(0, events, dt, (buttons, ms) => segments.push([buttons, ms]), (before,after,at)=>edges.push([before,after,at]));
  assert.equal(final, 0);
  assert.deepEqual(segments.map(x=>x[0]),[0,1,0]);
  assert.ok(Math.abs(segments[1][1] - .5*dt)<1e-10);
  assert.deepEqual(edges.map(e=>e.slice(0,2)),[[0,1],[1,0]]);
});
test('exact tick boundaries belong to the following tick', () => {
  const q = new SubtickInputBuffer();
  q.push(10, 'right');
  assert.deepEqual(q.take(0, 10), []);
  assert.deepEqual(q.take(10, 20), [{ fraction: 0, value:'right' }]);
  assert.deepEqual(q.take(20,30), []);
});
test('two events at the same time are ordered, and stored values are independent of caller mutation', () => {
  const q = new SubtickInputBuffer();
  const a={pressed:true}; q.push(0,a); a.pressed=false;
  q.push(0, {pressed:false});
  assert.deepEqual(q.take(0,10),[{fraction:0,value:{pressed:true}},{fraction:0,value:{pressed:false}}]);
});
// Each value is the whole input state (held buttons, axes), so a late transition is applied as soon as possible rather
// than lost: losing a key release would leave the key held. Only a transition that a newer one already replaced goes.
test('an event dispatched after its tick was taken is applied at the start of the next tick', () => {
  const q=new SubtickInputBuffer();q.push(5,'fire');
  assert.deepEqual(q.take(0,10),[{fraction:0.5,value:'fire'}]);
  q.push(9,'release');                                   // happened in the tick already taken, but after its last event
  assert.deepEqual(q.take(10,20),[{fraction:0,value:'release'}]);
  assert.equal(q.late,1); assert.equal(q.dropped,0); assert.equal(q.pending,0);
  assert.throws(()=>q.take(0,10),/Invalid subtick window/, 'overlapping windows are still a caller error');
  q.reset();q.push(9,'fresh');assert.equal(q.take(0,10).length,1);
});
test('a skipped window delivers its input at the start of the next one', () => {
  const q=new SubtickInputBuffer();q.push(5,'fire');
  assert.deepEqual(q.take(10,20),[{fraction:0,value:'fire'}]);
  assert.equal(q.late,1);
});
test('an event older than one already applied is out of date and dropped', () => {
  const q=new SubtickInputBuffer();q.push(8,'pressed');
  assert.deepEqual(q.take(0,10),[{fraction:0.8,value:'pressed'}]);
  q.push(3,'released');                                  // the press it preceded is already applied
  assert.deepEqual(q.take(10,20),[]);
  assert.equal(q.dropped,1); assert.equal(q.late,0);
});
test('overflow and per-tick bursts drop the earliest transitions and keep the newest state', () => {
  const q=new SubtickInputBuffer(3);q.push(2,1);q.push(3,2);q.push(4,3);
  q.push(5,4);
  assert.equal(q.pending,3); assert.equal(q.dropped,1);
  q.push(1,0);                                           // older than everything queued in a full buffer
  assert.equal(q.pending,3); assert.equal(q.dropped,2);
  assert.deepEqual(q.take(0,10,2).map(e=>e.value),[3,4]);
  assert.equal(q.dropped,3); assert.equal(q.pending,0);
  const small=new SubtickInputBuffer(1); small.push(0,'ok'); assert.equal(small.take(0,1)[0].value, 'ok');
  assert.throws(()=>new SubtickInputBuffer(0),RangeError);
  assert.throws(()=>q.push(NaN,1),RangeError);
  assert.throws(()=>q.take(10,10),RangeError);
});
test('out-of-order timestamps are sorted into place; future input waits for its tick',()=>{
  const q=new SubtickInputBuffer();q.push(32,'a');q.push(45,'future');q.push(33,'b');q.push(32,'c');
  assert.deepEqual(q.take(0,40).map(e=>e.value),['a','c','b'], 'equal times keep the order they were pushed');
  assert.equal(q.pending,1);
  assert.equal(q.take(40,50)[0].value,'future');
  assert.equal(q.late,0); assert.equal(q.dropped,0);
});
test('subtick replay validates all events before callbacks, including nonfinite and malformed',()=>{
  for(const list of [[{fraction:.6,value:1},{fraction:.2,value:0}],[{fraction:NaN,value:1}],[{fraction:1,value:1}],[{fraction:-.01,value:1}],[null]]){
    let calls=0;
    assert.throws(()=>replaySubtick(0,list,16,()=>calls++,()=>calls++),RangeError);
    assert.equal(calls,0);
  }
  assert.throws(()=>replaySubtick(0,[],0,()=>{}),RangeError);
  let total=0;assert.equal(replaySubtick(1,[],16,(_,ms)=>total+=ms),1);assert.equal(total,16);
});
test('server-valid rewind accepts near expected time and denies stale/future claims',()=>{
  assert.deepEqual(selectRewindTime(890,1000,900,200,20),{timeMs:890,source:'client',reason:'accepted'});
  assert.deepEqual(selectRewindTime(870,1000,900,200,20),{timeMs:900,source:'server',reason:'outside-tolerance'});
  assert.deepEqual(selectRewindTime(500,1000,900,200,500),{timeMs:900,source:'server',reason:'outside-window'});
  assert.deepEqual(selectRewindTime(1001,1000,900,200,500),{timeMs:900,source:'server',reason:'outside-window'});
  assert.deepEqual(selectRewindTime(undefined,1000,900,200,20),{timeMs:900,source:'server',reason:'missing'});
  assert.deepEqual(selectRewindTime(NaN,1000,900,200,20),{timeMs:900,source:'server',reason:'invalid'});
});
test('server expected rewind is bounded even if expected history is older than retained',()=>{
  assert.deepEqual(selectRewindTime(undefined,1000,0,200,5),{timeMs:null,source:'none',reason:'expected-outside-window'});
  assert.deepEqual(selectRewindTime(800,1000,0,200,5),{timeMs:null,source:'none',reason:'expected-outside-window'});
  assert.deepEqual(selectRewindTime(undefined,1000,1200,200,5),{timeMs:null,source:'none',reason:'expected-outside-window'});
  assert.deepEqual(selectRewindTime(1000,1000,1100,200,5),{timeMs:null,source:'none',reason:'expected-outside-window'});
  assert.deepEqual(selectRewindTime(800,1000,800,200,0),{timeMs:800,source:'client',reason:'accepted'});
  assert.deepEqual(selectRewindTime(undefined,1000,800,200,0),{timeMs:800,source:'server',reason:'missing'});
  assert.throws(()=>selectRewindTime(800,1000,900,-1,0),RangeError);
  assert.throws(()=>selectRewindTime(800,1000,900,200,NaN),RangeError);
});
test('128Hz boundaries retain event ordering and exact end state',()=>{
  const q=new SubtickInputBuffer(128);const dt=1000/128;
  for(let i=0;i<64;i++)q.push(i*dt+dt*.2, i%2);
  let prior=-1;for(let i=0;i<64;i++){const events=q.take(i*dt,(i+1)*dt);assert.equal(events.length,1);assert.ok(Math.abs(events[0].fraction-.2)<1e-12);const next=replaySubtick(prior,events,dt,()=>{});assert.equal(next,i%2);prior=next;}
});

test('callback mutations cannot change a prevalidated replay schedule', () => {
  const transitions = [{fraction: .2, value: 1}, {fraction: .8, value: 0}];
  let total = 0;
  const edges = [];
  assert.equal(replaySubtick(0, transitions, 16,
    (_held, dt) => { assert.ok(dt >= 0); total += dt; },
    (_before, _after, fraction) => {
      edges.push(fraction);
      if (fraction === .2) {
        transitions[1].fraction = -.5;
        transitions.push({fraction: NaN, value: 5});
      }
    }), 0);
  assert.equal(total, 16);
  assert.deepEqual(edges, [.2, .8]);
});

test('fraction accessors cannot change after validation', () => {
  let reads = 0;
  const event = { get fraction() { return ++reads === 1 ? .25 : -.5; }, value: 1 };
  const edges = [];
  let total = 0;
  const result = replaySubtick(0, [event], 8, (_, dt) => total += dt, (_, after, t) => edges.push([after, t]));
  assert.equal(result, 1);
  assert.equal(total, 8);
  assert.deepEqual(edges, [[1, .25]]);
  assert.equal(reads, 1);
});

test('reentrant cloning fails atomically instead of scrambling event order', () => {
  let b;
  b = new SubtickInputBuffer(4, value => { if (value === 'first') b.push(90, 'injected'); return value; });
  assert.throws(() => b.push(10, 'first'), /Reentrant subtick clone/);
  assert.equal(b.pending, 0);
  b.push(20, 'later');
  assert.deepEqual(b.take(0, 100), [{ fraction: .2, value: 'later' }]);
});

test('malicious clone can catch reentrant rejection without changing outer push', () => {
  let b, rejected = false;
  b = new SubtickInputBuffer(4, value => {
    if (value === 'first') try { b.push(90, 'injected'); } catch (e) { rejected = /Reentrant subtick clone/.test(e.message); }
    return value;
  });
  b.push(10, 'first'); b.push(20, 'second');
  assert.equal(rejected, true);
  assert.deepEqual(b.take(0, 100), [{ fraction: .1, value: 'first' }, { fraction: .2, value: 'second' }]);
});

test('overlarge finite numeric history cannot overflow the rewind interval', () => {
  assert.throws(() => selectRewindTime(undefined, -1e308, -1e308, 1e308, 1), RangeError);
  assert.throws(() => selectRewindTime(undefined, -Number.MAX_VALUE, 0, Number.MAX_VALUE, 1), RangeError);
});

function subtickRandom(seed) { let x = seed >>> 0; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }
test('seeded burst transitions preserve chronological time and final state at 20-240 Hz', () => {
  const r = subtickRandom(0x25792026);
  let count = 0;
  for (let run = 0; run < 512; run++) {
    const hz = [20, 30, 64, 128, 240][Math.floor(r() * 5)], dt = 1000 / hz;
    const ticks = 1 + Math.floor(r() * 25);
    const q = new SubtickInputBuffer(4096);
    const expected = [];
    let value = 0;
    for (let tick = 0; tick < ticks; tick++) {
      const fractions = Array.from({ length: Math.floor(r() * 7) }, () => Math.floor(r() * 1000) / 1000).sort((a, b) => a - b);
      for (const fraction of fractions) {
        value ^= 1;
        expected.push({ tick, fraction, value });
        q.push(tick * dt + fraction * dt, value);
      }
    }
    let cumulative = 0, final = 0, n = 0;
    for (let tick = 0; tick < ticks; tick++) {
      const transitions = q.take(tick * dt, (tick + 1) * dt);
      final = replaySubtick(final, transitions, dt, (_held, step) => { assert.ok(step >= 0); cumulative += step; }, () => n++);
    }
    assert.equal(final, value);
    assert.equal(n, expected.length);
    assert.ok(Math.abs(cumulative - ticks * dt) < 1e-7);
    assert.equal(q.pending, 0);
    count += expected.length;
  }
  assert.ok(count > 12000);
});

test('cloner cannot drain or clear existing inputs reentrantly', () => {
  for (const method of ['take', 'reset']) {
    let q;
    q = new SubtickInputBuffer(4, value => {
      if (value === 'bad') method === 'take' ? q.take(0, 10) : q.reset();
      return value;
    });
    q.push(0, 'good');
    assert.throws(() => q.push(1, 'bad'), /Reentrant subtick clone/);
    assert.equal(q.pending, 1);
    assert.deepEqual(q.take(0, 2), [{ fraction: 0, value: 'good' }]);
  }
});

test('server estimate outside history never validates a client time or invents a hit timestamp', () => {
  for (const expected of [0, 799.999, 1000.001, 1100]) {
    for (const requested of [undefined, 800, 900, 1000, NaN, Infinity]) {
      assert.deepEqual(selectRewindTime(requested, 1000, expected, 200, 100000), {
        timeMs: null, source: 'none', reason: 'expected-outside-window',
      });
    }
  }
  assert.deepEqual(selectRewindTime(800,1000,800,200,0),{timeMs:800,source:'client',reason:'accepted'});
  assert.deepEqual(selectRewindTime(1000,1000,1000,200,0),{timeMs:1000,source:'client',reason:'accepted'});
  assert.deepEqual(selectRewindTime(799.9,1000,800,200,1),{timeMs:800,source:'server',reason:'outside-window'});
});

test('replay snapshots future object values before callbacks mutate the original events', () => {
  const transitions = [{fraction:.25,value:{buttons:1}},{fraction:.75,value:{buttons:2}}];
  const steps = [], edges = [];
  const last = replaySubtick({buttons:0}, transitions, 16,
    (held, dt) => steps.push([held.buttons,dt]),
    (_before,after,fraction) => {
      edges.push([fraction,after.buttons]);
      if (fraction === .25) transitions[1].value.buttons = 255;
    });
  assert.deepEqual(steps.map(x=>x[0]), [0,1,2]);
  assert.deepEqual(edges, [[.25,1],[.75,2]]);
  assert.deepEqual(last,{buttons:2});
  assert.equal(transitions[1].value.buttons,255);
});

test('replay isolates aliased event objects and clones initial state', () => {
  const shared={buttons:1}, initial={buttons:0};
  const events=[{fraction:.25,value:shared},{fraction:.75,value:shared}];
  const trace=[];
  const final=replaySubtick(initial,events,16,
    (held,dt)=>trace.push([held.buttons,dt]),
    (_before,after,fraction)=>{if(fraction===.25){shared.buttons=200;initial.buttons=201;after.buttons=9;}});
  assert.deepEqual(trace.map(x=>x[0]),[0,9,1]);
  assert.deepEqual(final,{buttons:1});
});

test('all event cloning completes before any replay callback and fails atomically',()=>{
  const input=[{fraction:.25,value:{ok:true}},{fraction:.75,value:{bad:()=>true}}];
  let calls=0;
  assert.throws(()=>replaySubtick({ok:true},input,16,()=>calls++,()=>calls++),/clone|function/i);
  assert.equal(calls,0);
});

test('optional custom cloning supports non-structured-cloneable inputs',()=>{
  const a={buttons:0, fn:()=>0}, b={buttons:1, fn:()=>1};
  const seen=[];
  const final=replaySubtick(a,[{fraction:.5,value:b}],16,
    (held,dt)=>seen.push([held.buttons,dt]),
    ()=>{}, v=>({...v}));
  assert.deepEqual(seen,[[0,8],[1,8]]);
  assert.notEqual(final,b);
  assert.equal(final.fn(),1);
});

test('rewind selection never accepts a value inconsistent with independently expected time',()=>{
  let seed=0x15a77600;
  const rnd=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296};
  for(let i=0;i<10000;i++){
    const now=1000+rnd()*100000, max=1+rnd()*1000, expected=now-(rnd()*2-.5)*max*2;
    const request=now-rnd()*max, tolerance=rnd()*50;
    const result=selectRewindTime(request,now,expected,max,tolerance);
    const inside=expected>=now-max&&expected<=now;
    if(!inside){assert.deepEqual(result,{timeMs:null,source:'none',reason:'expected-outside-window'});continue;}
    assert.ok(result.timeMs>=now-max&&result.timeMs<=now);
    if(result.source==='client') assert.ok(Math.abs(result.timeMs-expected)<=tolerance+1e-9);
    else assert.equal(result.timeMs,expected);
  }
});
