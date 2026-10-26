import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameServer } from '../dist/server/index.js';
import { GameClient } from '../dist/client/index.js';
import { until, sleep } from './helpers.mjs';
async function setup(options = {}) {
  const errors = [];
  const server = await createGameServer({ origins: ['http://localhost'], allowMissingOrigin: true, onError: e => errors.push(e.message), ...options });
  const port = await server.listen(); const url = `ws://127.0.0.1:${port}/connect`;
  return { server, errors, url };
}
function client(url, extra = {}) { return new GameClient({ url, room: 'test', rtc: false, reconnectBaseMs: 20, ...extra }); }

test('queued frames on a retired takeover socket are ignored without reporting a new protocol violation', async () => {
  const { default: WS } = await import('ws');
  const { VERSION } = await import('../dist/core/protocol.js');
  const inputs = [];
  const s = await setup({ onSession: (session, resumed) => {
    if (!resumed) session.data = { seat: 0 };
    session.onState = state => inputs.push(state.data[0]);
  }});
  let raw, b;
  const a = client(s.url, { websocket: u => (raw = new WS(u)) });
  try {
    a.connect(); await until(() => a.status === 'online' && a.clock.synced);
    const id = a.id, checkpoint = a.checkpoint();
    raw._socket.pause(); // the replaced tab has not received the close yet and still has input in flight
    b = client(s.url, { checkpoint, websocket: u => new WS(u) });
    b.connect(); await until(() => b.status === 'online' && b.clock.synced);
    a.sendState(1, Uint8Array.of(91)); a.flush();
    raw.send(JSON.stringify({ t: 'hello', v: VERSION, room: 'test', token: checkpoint.token, auth: null }));
    b.sendState(1, Uint8Array.of(92)); b.flush(); await until(() => inputs.length > 0);
    raw._socket.resume(); await until(() => a.status === 'lost');
    await sleep(30);
    assert.equal(b.status, 'online', 'a queued hello on the closing socket cannot take the player back');
    assert.equal(s.server.sessions.get(id).endpoint.active, true);
    assert.equal(b.id, id); assert.equal(s.server.sessions.get(id).data.seat, 0);
    assert.deepEqual(inputs, [92], 'only the current connection controls the retained player');
    assert.deepEqual(s.errors, [], 'normal in-flight traffic on the retired socket is not a new bad-client error');
  } finally { raw?._socket.resume(); a.close(); b?.close(); await s.server.close(); }
});
test('real WebSocket joins, sends binary state and exchanges acknowledged events', async () => {
  const got = [], received = [];
  const s = await setup({ onSession: session => {
    session.onState = state => { got.push(state); session.sendState(state.stream, state.data); session.endpoint.flush(); };
    session.onEvent = event => session.sendEvent(event);
  }});
  const c = client(s.url); c.onEvent = d => received.push(d); c.onState = state => received.push([...state.data]);
  try {
    c.connect(); await until(() => c.status === 'online'); c.sendEvent({ hi: 'world' });
    await until(() => received.length === 1); assert.deepEqual(received[0], { hi: 'world' });
    await until(() => c.clock.uncertaintyMs !== Infinity); c.sendState(1, Uint8Array.of(4, 5)); c.flush();
    await until(() => received.length === 2); assert.deepEqual(received[1], [4, 5]); assert.equal(got.length, 1);
    await until(() => c.endpoint.events.size === 0); assert.equal(s.errors.length, 0);
  } finally { c.close(); await s.server.close(); }
});
test('resume retains player identity and both directions replay pending events', async () => {
  const incoming = [], outgoing = [];
  const s = await setup({ onSession: session => { session.onEvent = d => incoming.push(d); } });
  const c = client(s.url); c.onEvent = d => outgoing.push(d);
  try {
    c.connect(); await until(() => c.status === 'online'); const id = c.id;
    c.pause(); await until(() => !s.server.sessions.get(id).connected);
    c.sendEvent('offline command'); s.server.sessions.get(id).sendEvent('offline message');
    c.resume(); await until(() => c.status === 'online'); assert.equal(c.id, id);
    await until(() => incoming.length && outgoing.length); assert.deepEqual(incoming, ['offline command']); assert.deepEqual(outgoing, ['offline message']);
    assert.equal(s.server.stats.sessionResumes, 1);
  } finally { c.close(); await s.server.close(); }
});
test('expired session is reported and pending actions are not replayed into a new room', async () => {
  const s = await setup({ resumeGraceMs: 30 }); const c = client(s.url); let loss;
  c.onSessionLost = info => loss = info;
  try {
    c.connect(); await until(() => c.status === 'online'); c.pause(); c.sendEvent('old action');
    await until(() => s.server.sessions.size === 0); c.resume(); await until(() => c.status === 'lost');
    assert.equal(loss.pendingEvents, 1); c.newSession(); await until(() => c.status === 'online'); assert.equal(c.endpoint.events.size, 0);
  } finally { c.close(); await s.server.close(); }
});
test('checkpoints resume the same logical session with delivery counters intact', async () => {
  const s = await setup({ onSession: session => { session.onEvent = data => session.sendEvent(data); } });
  const a = client(s.url); let b; let events = 0; a.onEvent = () => events++;
  try {
    a.connect(); await until(() => a.status === 'online'); a.sendEvent('before'); await until(() => events === 1 && !a.endpoint.events.size);
    a.pause(); const cp = a.checkpoint(); b = client(s.url, { checkpoint: cp }); b.onEvent = () => events++;
    b.connect(); await until(() => b.status === 'online'); assert.equal(b.id, a.id);
    b.sendEvent('after'); await until(() => events === 2); assert.equal(s.server.sessions.size, 1);
  } finally { a.pause(); b?.close(); await s.server.close(); }
});
test('authentication is revalidated on resume and cannot change the session subject', async () => {
  const s = await setup({ authenticate: ({ auth }) => auth === 'valid' ? 'user-1' : null });
  const a = client(s.url, { auth: 'valid' }); let b;
  try {
    a.connect(); await until(() => a.status === 'online'); a.pause(); const cp = a.checkpoint();
    b = client(s.url, { checkpoint: cp, auth: 'wrong' }); b.connect(); await sleep(150);
    assert.notEqual(b.status, 'online'); assert.equal(s.server.sessions.get(a.id).connected, false);
  } finally { a.pause(); b?.close(); await s.server.close(); }
});
test('room identity is bound into the session checkpoint', () => {
  assert.throws(() => client('ws://localhost/connect', { checkpoint: { url: 'ws://elsewhere/connect', room: 'test', token: 'a'.repeat(32), id: 'x', events: {} } }));
});
test('a closed old socket does not tear down a newer resumed connection', async () => {
  const s = await setup(); const a = client(s.url); let b;
  try {
    a.connect(); await until(() => a.status === 'online'); const cp = a.checkpoint();
    b = client(s.url, { checkpoint: cp }); b.connect(); await until(() => b.status === 'online'); a.pause();
    await sleep(50); assert.ok(s.server.sessions.get(b.id).connected); assert.equal(s.server.sessions.size, 1);
  } finally { a.pause(); b?.close(); await s.server.close(); }
});
test('unauthenticated sockets expire without creating sessions', async () => {
  const s = await setup({ handshakeTimeoutMs: 30 }); const ws = new WebSocket(s.url); let closed = false;
  ws.onclose = () => closed = true;
  try { await until(() => closed); assert.equal(s.server.sessions.size, 0); } finally { ws.close(); await s.server.close(); }
});
test('malformed input closes only that peer, not the server', async () => {
  const s = await setup(); const ws = new WebSocket(s.url); let closed = false; ws.onclose = () => closed = true;
  ws.onopen = () => ws.send('{broken');
  const c = client(s.url);
  try { await until(() => closed); c.connect(); await until(() => c.status === 'online'); assert.ok(s.server.stats.protocolErrors >= 1); }
  finally { c.close(); ws.close(); await s.server.close(); }
});
test('explicitly leaving releases the server session', async () => {
  const s = await setup(); const c = client(s.url);
  try { c.connect(); await until(() => c.status === 'online'); c.close(); await until(() => s.server.sessions.size === 0); }
  finally { c.close(); await s.server.close(); }
});

test('a resumed second tab does not trigger a session takeover reconnect loop', async () => {
  const s = await setup(); const a = client(s.url); let b; let loss;
  a.onSessionLost = info => loss = info;
  try {
    a.connect(); await until(() => a.status === 'online');
    b = client(s.url, { checkpoint: a.checkpoint() }); b.connect();
    await until(() => b.status === 'online' && a.status === 'lost');
    await sleep(80);
    assert.equal(s.server.stats.sessionResumes, 1); assert.equal(b.status, 'online');
    assert.match(loss.reason, /elsewhere/);
  } finally { a.pause(); b?.close(); await s.server.close(); }
});

test('a full reliable outbox is reported per recipient without aborting a room broadcast', async () => {
  const s = await setup(); const a = client(s.url), b = client(s.url); const received = [];
  b.onEvent = e => received.push(e);
  try {
    a.connect(); b.connect(); await until(() => a.status === 'online' && b.status === 'online');
    a.pause(); await until(() => !s.server.sessions.get(a.id).connected);
    for (let i = 0; i < 512; i++) s.server.sessions.get(a.id).sendEvent(i);
    const result = s.server.broadcast('test', 'broadcast');
    assert.deepEqual(result, { queued: 1, rejected: [a.id] });
    await until(() => received.length === 1); assert.equal(received[0], 'broadcast');
    assert.equal(b.status, 'online');
  } finally { a.pause(); b.close(); await s.server.close(); }
});

test('client rejects invalid room names before attempting a connection', () => {
  assert.throws(() => client('ws://localhost/connect', { room: 'a/b' }), /room/);
});

test('one address cannot fill the session table: its oldest dropped session makes way', async () => {
  const s = await setup({ maxSessions: 8, maxPerIp: 4 }); const clients = [];
  try {
    for (let i = 0; i < 10; i++) {
      const c = client(s.url); clients.push(c); c.connect(); await until(() => c.status === 'online');
      const id = c.id; c.pause(); await until(() => !s.server.sessions.get(id)?.connected);
    }
    assert.ok(s.server.sessions.size <= 4, 'sessions: ' + s.server.sessions.size);
    for (const c of clients.slice(-4)) assert.ok(s.server.sessions.has(c.id), 'the newest sessions stay');
    const last = client(s.url); clients.push(last); last.connect(); await until(() => last.status === 'online');
  } finally { for (const c of clients) c.close(); await s.server.close(); }
});

test('after connecting the client sends a burst of pings, so the clock settles in about two seconds', async () => {
  const s = await setup(); const c = client(s.url);
  try {
    c.connect(); await until(() => c.status === 'online');
    const t0 = performance.now(); await until(() => c.clock.sampleCount >= 8, 3500);
    assert.ok(performance.now() - t0 < 3000, 'eight samples in ' + Math.round(performance.now() - t0) + ' ms');
    s.server.sessions.get(c.id).sendEvent({ hello: 1 }); s.server.sessions.get(c.id).flush();
  } finally { c.close(); await s.server.close(); }
});

test('a page that unloads leaves (no ghost for the resume grace) unless it checkpoints or is kept in the bfcache', async () => {
  const s = await setup({ resumeGraceMs: 60000 });
  const hadWindow = 'window' in globalThis, hadDocument = 'document' in globalThis;
  globalThis.window = new EventTarget(); globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const pagehide = persisted => { const e = new Event('pagehide'); Object.defineProperty(e, 'persisted', { value: persisted }); window.dispatchEvent(e); };
  const clients = [];
  const join = async () => { const c = client(s.url); clients.push(c); c.connect(); await until(() => c.status === 'online'); c.bindPageLifecycle(); return c; };
  try {
    const gone = await join(), id1 = gone.id;
    pagehide(false); await until(() => !s.server.sessions.has(id1)); assert.equal(gone.status, 'closed', 'closed: the server ended it at once');
    const saved = await join(), id2 = saved.id; saved.checkpoint();
    pagehide(false); await until(() => s.server.sessions.get(id2)?.connected === false);
    assert.equal(saved.status, 'paused', 'a checkpointing page keeps its session for the reload');
    const cached = await join(), id3 = cached.id;
    pagehide(true); await until(() => s.server.sessions.get(id3)?.connected === false);
    assert.equal(cached.status, 'paused', 'a page in the back/forward cache can come back');
    const told = await join(), id4 = told.id; told.bindPageLifecycle({ unload: 'pause' });
    pagehide(false); await until(() => s.server.sessions.get(id4)?.connected === false); assert.equal(told.status, 'paused');
  } finally {
    for (const c of clients) c.close(); await s.server.close();
    if (!hadWindow) delete globalThis.window; if (!hadDocument) delete globalThis.document;
  }
});

test('the clock estimate survives a dropped connection (same server, same clock) and is redone for a new session', async () => {
  const s = await setup(); const c = client(s.url);
  try {
    c.connect(); await until(() => c.status === 'online' && c.clock.synced);
    c.simulateDrop(); await until(() => c.status !== 'online');
    assert.ok(c.clock.synced, 'still synced while reconnecting: serverTime() stays on the server timeline');
    await until(() => c.status === 'online'); await until(() => c.clock.sampleCount >= 9, 3500);
    c.newSession(); await until(() => c.status === 'online');
    assert.ok(c.clock.sampleCount <= 2, 'a new session starts the estimate over');
  } finally { c.close(); await s.server.close(); }
});

test('a 128 Hz game: the default 60 Hz pump coalesces its states; pumpHz 128, or flush() per tick, carries each one', async () => {
  for (const [label, pumpHz, flush, min, max] of [['default pump', undefined, false, 30, 80], ['pumpHz 128', 128, false, 100, 140], ['flush per tick', undefined, true, 100, 140]]) {
    let session; const s = await setup({ ...(pumpHz ? { pumpHz } : {}), endpoint: { bytesPerSecond: 192 * 1024 }, onSession: x => { session = x; } });
    const c = client(s.url, { endpoint: { bytesPerSecond: 192 * 1024 } }); let got = 0; c.onState = () => got++;
    try {
      c.connect(); await until(() => c.status === 'online' && session);
      let n = 0;
      await new Promise(r => { const iv = setInterval(() => { session.sendState(1, new Uint8Array(400)); if (flush) session.flush(); if (++n >= 128) { clearInterval(iv); r(); } }, 1000 / 128); });
      await sleep(150);
      assert.ok(got >= min && got <= max, label + ': ' + got + ' of 128 states arrived');
    } finally { c.close(); await s.server.close(); }
  }
  await assert.rejects(async () => createGameServer({ origins: [], allowMissingOrigin: true, pumpHz: 1000 }), /pumpHz/);
});
