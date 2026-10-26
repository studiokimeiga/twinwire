import test from 'node:test';
import assert from 'node:assert/strict';
import { GameClient } from '../dist/client/index.js';
import { createGameServer } from '../dist/server/index.js';
import { AdaptivePlayback, Timeline } from '../dist/netcode/index.js';
import { sleep, until } from './helpers.mjs';

async function setup() {
  const errors = [];
  const server = await createGameServer({ origins: [], allowMissingOrigin: true, onError: e => errors.push(e.message) });
  const port = await server.listen();
  const client = new GameClient({ url: `ws://127.0.0.1:${port}/connect`, room: 'recovery', rtc: false, reconnectBaseMs: 10 });
  client.onError = e => errors.push(e.message);
  if (typeof client.receiveState !== 'function') {
    await server.close();
    assert.equal(typeof client.receiveState, 'function', 'the client must provide session-aware state recovery');
  }
  const connect = async () => { client.connect(); await until(() => client.status === 'online' && client.clock.synced); };
  const send = async (stream, bytes, age = 0) => {
    const session = server.sessions.get(client.id);
    const received = client.endpoint.stats.statesReceived;
    session.endpoint.sendState(stream, bytes, performance.now() - age); session.flush();
    await until(() => client.endpoint.stats.statesReceived > received);
  };
  return { server, client, errors, connect, send, close: async () => { client.close(); await server.close(); } };
}

test('retained replay holds across pause and online until a usable fresh snapshot arrives', async () => {
  const s = await setup();
  const timeline = new Timeline();
  const playback = new AdaptivePlayback(20, 20, 200);
  let received = 0, resets = 0, event;
  const receiver = s.client.receiveState({ stream: 0, resume: 'retain', playback, maxExtrapolationMs: 100,
    reset: () => { resets++; timeline.clear(); },
    apply: state => {
      received++;
      if (state.data[0] !== 1) return false; // malformed, or a delta whose base is absent
      timeline.insert({ time: state.time, seq: state.seq, value: state.data[1] }); return true;
    },
  });
  try {
    await s.connect(); assert.equal(resets, 1); assert.equal(receiver.advance(16), null);
    await s.send(0, Uint8Array.of(1, 10)); assert.equal(receiver.ready, true);
    const before = receiver.advance(16), id = s.client.id, clockSamples = s.client.clock.sampleCount;
    s.client.endpoint.detach();
    assert.equal(receiver.advance(16), null, 'a detached socket is not ready even before its status callback runs');
    s.client.pause(); assert.equal(receiver.ready, false); assert.equal(receiver.advance(16), null);
    await sleep(160); s.client.resume(); await until(() => s.client.status === 'online');
    assert.equal(s.client.id, id); assert.ok(s.client.clock.sampleCount >= clockSamples);
    assert.equal(resets, 1, 'retained history survives the resumed session'); assert.equal(timeline.size, 1);
    assert.equal(receiver.advance(16), null, 'online plus a retained clock is not fresh state');
    s.client.onEvent = value => event = value;
    serverSession(s).sendEvent('events stay live'); await until(() => event);
    assert.equal(event, 'events stay live');
    assert.ok(s.client.sendState(1, Uint8Array.of(9)) > 0, 'outbound movement is independent of remote readiness');
    await s.send(1, Uint8Array.of(1, 11)); assert.equal(receiver.ready, false, 'an unrelated stream cannot release replay');
    await s.send(0, Uint8Array.of(0)); assert.equal(receiver.ready, false, 'an unusable payload cannot release replay');
    await s.send(0, Uint8Array.of(1, 12), 5000); assert.equal(receiver.advance(16), null, 'queued old state is not recovery');
    await s.send(0, Uint8Array.of(1, 13));
    const after = receiver.advance(16); assert.ok(after > before); assert.equal(receiver.ready, true);
    assert.equal(received, 4); assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

const serverSession = s => s.server.sessions.get(s.client.id);

test('reset-on-resume clears application buffers and playback before callbacks observe the session', async () => {
  const s = await setup(); const history = new Timeline(), playback = new AdaptivePlayback(20);
  let resets = 0;
  const receiver = s.client.receiveState({ stream: 0, playback,
    reset: () => { history.clear(); resets++; },
    apply: state => { history.insert({ time: state.time, seq: state.seq, value: 1 }); return true; },
  });
  try {
    await s.connect(); await s.send(0, Uint8Array.of(1)); assert.equal(receiver.ready, true); receiver.advance(16);
    assert.equal(history.size, 1);
    let callback;
    s.client.onSession = info => callback = { resumed: info.resumed, size: history.size, ready: receiver.ready };
    s.client.pause(); s.client.resume(); await until(() => callback);
    assert.deepEqual(callback, { resumed: true, size: 0, ready: false }); assert.equal(resets, 2);
    await s.send(0, Uint8Array.of(1)); assert.equal(receiver.ready, true); assert.equal(history.size, 1);
    s.client.newSession(); await until(() => s.client.status === 'online' && s.client.clock.synced);
    assert.equal(history.size, 0); assert.equal(resets, 3); assert.equal(receiver.advance(16), null);
  } finally { await s.close(); }
});

test('a retained receiver still resets on a new session, even when the new clock is numerically close', async () => {
  const s = await setup(); const playback = new AdaptivePlayback(20); let resets = 0;
  const receiver = s.client.receiveState({ stream: 0, playback, resume: 'retain', reset: () => resets++, apply: () => true });
  try {
    await s.connect(); await s.send(0, Uint8Array.of(1)); receiver.advance(16); const old = s.client.id;
    s.client.newSession(); await until(() => s.client.status === 'online' && s.client.clock.synced);
    assert.notEqual(s.client.id, old); assert.equal(resets, 2); assert.equal(receiver.ready, false);
    await s.send(0, Uint8Array.of(1)); assert.notEqual(receiver.advance(16), null);
  } finally { await s.close(); }
});

test('an idle snapshot header releases recovery even when its entity sample has not changed', async () => {
  const s = await setup(); const playback = new AdaptivePlayback(20); let entityTime = 0;
  const receiver = s.client.receiveState({ stream: 0, playback, resume: 'retain', apply: state => { entityTime ||= state.time; return true; } });
  try {
    await s.connect(); await s.send(0, Uint8Array.of(1)); const idleSince = entityTime;
    assert.equal(receiver.ready, true); s.client.pause(); await sleep(160); s.client.resume();
    await until(() => s.client.status === 'online'); assert.equal(receiver.ready, false);
    await s.send(0, Uint8Array.of(1)); assert.equal(entityTime, idleSince); assert.equal(receiver.ready, true);
  } finally { await s.close(); }
});

test('future-dated state and a failed decoder cannot make recovery ready or poison the next valid state', async () => {
  const s = await setup(); let fail = true, observed = 0;
  s.client.onState = () => observed++;
  const receiver = s.client.receiveState({ stream: 0, apply: () => { if (fail) throw new Error('bad snapshot'); return true; } });
  try {
    await s.connect(); await s.send(0, Uint8Array.of(1)); assert.equal(receiver.ready, false); assert.deepEqual(s.errors, ['bad snapshot']);
    fail = false; await s.send(0, Uint8Array.of(1), -10000); assert.equal(receiver.ready, false);
    await s.send(0, Uint8Array.of(1)); assert.equal(receiver.ready, true); assert.equal(observed, 3);
  } finally { await s.close(); }
});

test('state callbacks cannot release recovery if they pause the session while applying data', async () => {
  const s = await setup();
  const receiver = s.client.receiveState({ stream: 0, resume: 'retain', apply: () => { s.client.pause(); return true; } });
  try {
    await s.connect(); await s.send(0, Uint8Array.of(1)); assert.equal(receiver.ready, false);
    s.client.resume(); await until(() => s.client.status === 'online'); assert.equal(receiver.ready, false);
  } finally { await s.close(); }
});

test('receiver bounds, validation, disposal and reset failures are explicit', async () => {
  const s = await setup();
  try {
    for (const stream of [-1, 65536, NaN]) assert.throws(() => s.client.receiveState({ stream, apply: () => true }), /stream/i);
    for (const maxExtrapolationMs of [-1, Infinity, NaN]) assert.throws(() => s.client.receiveState({ stream: 0, maxExtrapolationMs, apply: () => true }), /extrapolation/i);
    assert.throws(() => s.client.receiveState({ stream: 0, resume: 'typo', apply: () => true }), /resume/i);
    const receiver = s.client.receiveState({ stream: 0, apply: () => true });
    assert.throws(() => s.client.receiveState({ stream: 0, apply: () => true }), /already/i);
    assert.throws(() => receiver.advance(16), /playback/i);
    receiver.dispose(); receiver.dispose(); assert.equal(receiver.ready, false);
    const next = s.client.receiveState({ stream: 0, reset: () => { throw new Error('reset failed'); }, apply: () => true });
    await s.connect(); await s.send(0, Uint8Array.of(1)); assert.equal(next.ready, false, 'a broken reset fails closed');
    assert.deepEqual(s.errors, ['reset failed']);
    const bounded = new GameClient({ url: s.client.options.url, room: 'bounded', rtc: false, endpoint: { maxStreams: 1 } });
    const first = bounded.receiveState({ stream: 1, apply: () => true });
    assert.throws(() => bounded.receiveState({ stream: 2, apply: () => true }), /too many/i);
    first.dispose(); bounded.receiveState({ stream: 2, apply: () => true }); bounded.close();
  } finally { await s.close(); }
});

test('a reset callback that closes the client cannot be overwritten by the pending welcome', async () => {
  const s = await setup();
  s.client.receiveState({ stream: 0, reset: () => s.client.close(), apply: () => true });
  try {
    s.client.connect(); await until(() => s.client.status === 'closed');
    await sleep(30); assert.equal(s.client.status, 'closed');
  } finally { await s.close(); }
});

test('a grouped snapshot receiver accepts its decoded family while rejecting unrelated world streams', async () => {
  const s = await setup(); let applied = 0;
  try {
    const receiver = s.client.receiveState({ resume: 'retain',
      apply: state => { if (state.stream < 16 || state.stream >= 1024 || state.data[0] !== 1) return false; applied++; return true; },
    });
    await s.connect(); await s.send(16, Uint8Array.of(1)); assert.equal(receiver.ready, true);
    s.client.pause(); s.client.resume(); await until(() => s.client.status === 'online');
    await s.send(1024, Uint8Array.of(1)); assert.equal(receiver.ready, false);
    await s.send(18, Uint8Array.of(0)); assert.equal(receiver.ready, false);
    await s.send(18, Uint8Array.of(1)); assert.equal(receiver.ready, true); assert.equal(applied, 2);
  } finally { await s.close(); }
});

test('recovery can learn a slower network without first advancing the old playback cursor', async () => {
  const s = await setup(); const playback = new AdaptivePlayback(20, 20, 400);
  const receiver = s.client.receiveState({ stream: 0, playback, resume: 'retain', maxExtrapolationMs: 50, apply: () => true });
  try {
    await s.connect(); await s.send(0, Uint8Array.of(1)); const before = receiver.advance(16);
    s.client.pause(); s.client.resume(); await until(() => s.client.status === 'online');
    let after = null;
    for (let i = 0; i < 30 && after === null; i++) {
      await s.send(0, Uint8Array.of(1), 200);
      after = receiver.advance(20); await sleep(20);
    }
    assert.notEqual(after, null, 'fresh snapshots must teach the delay policy even while replay is held');
    assert.ok(after >= before, 'the retained cursor never rewinds'); assert.ok(playback.delayMs > 100);
  } finally { await s.close(); }
});

test('online stale-payload traffic holds replay until a current generation arrives', async () => {
  const s=await setup(),playback=new AdaptivePlayback(20,20,200);let accepted=0,resets=0,advances=0;
  const advance=playback.advance.bind(playback);playback.advance=(...args)=>{advances++;return advance(...args);};
  const receiver=s.client.receiveState({stream:0,playback,resume:'retain',maxExtrapolationMs:50,
    reset:()=>resets++,apply:state=>{if(state.data[0]!==1)return false;accepted++;return true;}});
  const manual=s.client.receiveState({stream:2,maxExtrapolationMs:50,apply:()=>true});
  try {
    await s.connect();await s.send(0,Uint8Array.of(1));await s.send(2,Uint8Array.of(1));
    const before=receiver.advance(16);assert.equal(manual.ready,true);
    await sleep(15);assert.notEqual(receiver.advance(16),null,'ordinary loss inside the prediction budget remains usable');
    const held=advances;
    await sleep(130);
    for(let i=0;i<3;i++){
      await s.send(0,Uint8Array.of(1),2000);
      assert.equal(receiver.advance(16),null,'receiving old payloads is not current world data');
      assert.equal(advances,held,'do not advance the declared replay time over a stale online backlog');
    }
    assert.equal(s.client.status,'online');assert.equal(s.client.clock.synced,true);
    assert.equal(receiver.ready,false);assert.equal(manual.ready,false,'manual frame-clock adapters also check age continuously');
    assert.ok(s.client.sendState(1,Uint8Array.of(9))>0,'outbound controls are independent');
    await s.send(1,Uint8Array.of(1));assert.equal(receiver.ready,false,'unrelated live streams cannot release it');
    await s.send(0,Uint8Array.of(0));assert.equal(receiver.ready,false,'a rejected decoder cannot release it');
    await s.send(0,Uint8Array.of(1));
    assert.ok(receiver.advance(16)>before);assert.equal(receiver.ready,true);
    assert.equal(manual.ready,false,'the independent stale stream stays held');
    assert.equal(resets,1,'an online freshness hold retains application histories');
    assert.equal(accepted,5);assert.deepEqual(s.errors,[]);
  } finally {await s.close();}
});
