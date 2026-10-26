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
test('old input and skipped windows throw instead of being shifted to the next tick', () => {
  const q=new SubtickInputBuffer();q.push(5,'fire');
  assert.throws(()=>q.take(10,20),/Skipped/);
  assert.equal(q.pending,1);
  assert.deepEqual(q.take(0,10),[{fraction:0.5,value:'fire'}]);
  assert.throws(()=>q.push(9,'past'),/already-consumed/);
  assert.throws(()=>q.take(0,10),/Invalid subtick window/);
  q.reset();q.push(9,'fresh');assert.equal(q.take(0,10).length,1);
});
test('overflow or bad take is atomic and explicit', () => {
  const q=new SubtickInputBuffer(3);q.push(2,1);q.push(3,2);q.push(4,3);
  assert.throws(()=>q.push(5,4),/full/);
  assert.throws(()=>q.take(0,10,2),/per-tick/);
  assert.equal(q.pending,3);
  assert.equal(q.take(0,10,3).length,3);
  const small=new SubtickInputBuffer(1); small.push(0,'ok'); assert.equal(small.take(0,1)[0].value, 'ok');
  assert.throws(()=>new SubtickInputBuffer(0),RangeError);
  assert.throws(()=>q.push(NaN,1),RangeError);
  assert.throws(()=>q.take(10,10),RangeError);
});
test('out-of-order timestamps are rejected; future input waits for correct tick',()=>{
  const q=new SubtickInputBuffer();q.push(32,'late');q.push(45,'future');
  assert.throws(()=>q.push(33,'old'),RangeError);
  assert.equal(q.take(0,40).length,1);
  assert.equal(q.pending,1);
  assert.equal(q.take(40,50)[0].value,'future');
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
  assert.deepEqual(selectRewindTime(undefined,1000,0,200,5),{timeMs:800,source:'server',reason:'missing'});
  assert.deepEqual(selectRewindTime(800,1000,0,200,5),{timeMs:800,source:'client',reason:'accepted'});
  assert.deepEqual(selectRewindTime(undefined,1000,1200,200,5),{timeMs:1000,source:'server',reason:'missing'});
  assert.throws(()=>selectRewindTime(800,1000,900,-1,0),RangeError);
  assert.throws(()=>selectRewindTime(800,1000,900,200,NaN),RangeError);
});
test('128Hz boundaries retain event ordering and exact end state',()=>{
  const q=new SubtickInputBuffer(128);const dt=1000/128;
  for(let i=0;i<64;i++)q.push(i*dt+dt*.2, i%2);
  let prior=-1;for(let i=0;i<64;i++){const events=q.take(i*dt,(i+1)*dt);assert.equal(events.length,1);assert.ok(Math.abs(events[0].fraction-.2)<1e-12);const next=replaySubtick(prior,events,dt,()=>{});assert.equal(next,i%2);prior=next;}
});
