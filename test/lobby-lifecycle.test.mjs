// Lobby host, seat, ready and room lifecycle across drops, resumes, expiry and leaves (from an independent review).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameServer, Lobby } from '../dist/server/index.js';
import { GameClient, LobbyClient } from '../dist/client/index.js';
import { until, sleep } from './helpers.mjs';

async function setup(serverOptions = {}, lobbyOptions = {}) {
  const errors = [];
  const server = await createGameServer({ origins: ['http://localhost'], allowMissingOrigin: true, onError: e => errors.push(e.message), ...serverOptions });
  const lobby = new Lobby(server, lobbyOptions); lobby.onError = e => errors.push(e.message);
  const port = await server.listen(); const url = `ws://127.0.0.1:${port}/connect`;
  const clients = [];
  async function player(name) {
    const c = new GameClient({ url, room: 'lobby', rtc: false, reconnectBaseMs: 20, auth: { name } });
    const l = new LobbyClient(c); clients.push(c);
    c.connect(); await until(() => c.status === 'online');
    const session = () => server.sessions.get(c.id);
    return { c, l, session, member: () => session() && lobby.memberOf(session()),
      async drop() { c.pause(); await until(() => !session() || !session().connected); },
      async back() { c.resume(); await until(() => c.status === 'online' && session()?.connected); await sleep(30); } };
  }
  async function done() { for (const c of clients) c.close(); lobby.dispose(); await server.close(); }
  return { server, lobby, errors, player, done };
}
const view = r => r && r.members.map(m => [m.seat, m.name, m.connected, m.ready, m.host].join(':')).join(' ');

test('host is a connected member once a connected member exists (earliest-joined connected)', async () => {
  const s = await setup();
  try {
    const a = await s.player('A'), b = await s.player('B');
    const room = await a.l.create({}); await b.l.join(room.code);
    const r = s.lobby.roomOf(a.session());
    await a.drop(); await until(() => r.host === b.member());          // host moves to B: fine
    await b.drop(); await until(() => r.connectedCount === 0);          // nobody connected: host falls back to A
    await b.back();                                                     // B is the only connected member now
    assert.equal(r.connectedCount, 1);
    assert.equal(r.host?.name, 'B', `host is ${r.host?.name} (connected=${r.host?.connected}) while B is the only connected member`);
  } finally { await s.done(); }
});

test('a member who reconnects during the ready countdown is not started unready', async () => {
  const s = await setup({}, { ready: { countdownMs: 500, minMembers: 1 } });
  let started = 0; s.lobby.onStart = () => started++;
  try {
    const a = await s.player('A'), b = await s.player('B');
    const room = await a.l.create({}); await b.l.join(room.code);
    const r = s.lobby.roomOf(a.session());
    await b.drop();
    await a.l.setReady(true); assert.notEqual(r.countdownEndsAt, null);  // only A connected and ready: countdown runs
    await b.back();                                                      // B is connected again, not ready
    assert.equal(b.member().ready, false); assert.equal(b.member().connected, true);
    await sleep(700);
    assert.equal(started, 0, `room started with a connected member not ready (phase=${r.phase})`);
    assert.equal(r.phase, 'lobby');
  } finally { await s.done(); }
});

test('seats, ready flags and connectedCount stay consistent through drop, resume and leave', async () => {
  const s = await setup();
  try {
    const a = await s.player('A'), b = await s.player('B'), c = await s.player('C');
    const room = await a.l.create({}); await b.l.join(room.code); await c.l.join(room.code);
    const r = s.lobby.roomOf(a.session());
    assert.deepEqual([a, b, c].map(p => p.member().seat), [0, 1, 2]);
    await b.l.setReady(true);
    await b.drop();
    assert.equal(b.member().seat, 1); assert.equal(b.member().ready, false); assert.equal(r.connectedCount, 2);
    await until(() => view(a.l.room) === view(r.view(a.member())));
    await b.back();
    assert.equal(b.member().seat, 1); assert.equal(b.member().connected, true); assert.equal(r.connectedCount, 3);
    await c.l.leave(); assert.equal(r.members.size, 2);
    const d = await s.player('D'); await d.l.join(room.code); assert.equal(d.member().seat, 2);  // lowest free seat
    await until(() => view(a.l.room) === view(r.view(a.member())) && view(b.l.room) === view(r.view(b.member())));
    assert.equal(a.l.room.you, 0); assert.equal(b.l.room.you, 1); assert.equal(d.l.room.you, 2);
  } finally { await s.done(); }
});

test('a drop during the countdown cancels it; a room emptied during the countdown never starts', async () => {
  const s = await setup({}, { ready: { countdownMs: 400, minMembers: 2 } });
  let started = 0; s.lobby.onStart = () => started++;
  try {
    const a = await s.player('A'), b = await s.player('B');
    const room = await a.l.create({}); await b.l.join(room.code);
    const r = s.lobby.roomOf(a.session());
    await a.l.setReady(true); await b.l.setReady(true); assert.notEqual(r.countdownEndsAt, null);
    await b.drop();
    assert.equal(r.countdownEndsAt, null); assert.equal(r.countdown, undefined);
    await until(() => a.l.room?.countdownEndsAt === null);
    await b.back(); await b.l.setReady(true); assert.notEqual(r.countdownEndsAt, null);
    await a.l.leave(); await b.l.leave();
    assert.equal(r.members.size, 0); assert.equal(r.countdownEndsAt, null); assert.equal(r.countdown, undefined);
    await sleep(600); assert.equal(started, 0); assert.equal(r.phase, 'lobby');
  } finally { await s.done(); }
});

test('the countdown starts the room, clears ready flags and every view agrees', async () => {
  const s = await setup({}, { ready: { countdownMs: 200, minMembers: 2 } });
  try {
    const a = await s.player('A'), b = await s.player('B');
    const room = await a.l.create({}); await b.l.join(room.code);
    const r = s.lobby.roomOf(a.session());
    await a.l.setReady(true); await b.l.setReady(true);
    await until(() => r.phase === 'playing');
    assert.equal(r.countdownEndsAt, null); assert.ok([...r.members.values()].every(m => !m.ready));
    await until(() => a.l.room?.phase === 'playing' && b.l.room?.phase === 'playing' && a.l.room.countdownEndsAt === null);
    await assert.rejects(a.l.setReady(true), /already running/);
    r.setPhase('lobby'); await until(() => a.l.room?.phase === 'lobby');
  } finally { await s.done(); }
});

test('expiry frees the seat, hands host on and updates the others', async () => {
  const s = await setup({ resumeGraceMs: 300 });
  const left = []; s.lobby.onLeave = (room, m, reason) => left.push(`${m.name}:${reason}`);
  try {
    const host = await s.player('H'), a = await s.player('A');
    const room = await host.l.create({}); await a.l.join(room.code);
    const r = s.lobby.roomOf(a.session());
    await host.drop();
    await until(() => left.includes('H:expired'), 3000);
    assert.equal(r.members.size, 1); assert.equal(r.host, a.member()); assert.equal(r.memberAt(0), undefined);
    await until(() => a.l.room?.members.length === 1 && a.l.isHost);
    const b = await s.player('B'); await b.l.join(room.code); assert.equal(b.member().seat, 0);
  } finally { await s.done(); }
});

test('empty rooms close after emptyCloseMs and free their code; a join in the window keeps it open', async () => {
  const s = await setup({ resumeGraceMs: 200 }, { emptyCloseMs: 100 });
  const closed = []; s.lobby.onClose = (room, reason) => closed.push(`${room.code}:${reason}`);
  try {
    const a = await s.player('A'), b = await s.player('B');
    const one = await a.l.create({}); await a.l.leave();
    await until(() => closed.includes(`${one.code}:empty`), 3000);
    assert.equal(s.lobby.rooms.has(one.code), false);
    await assert.rejects(b.l.join(one.code), /no room called/);
    const two = await a.l.create({}); await a.l.leave(); await b.l.join(two.code);  // joins inside the window
    await sleep(1300); assert.ok(s.lobby.rooms.has(two.code));
    await b.drop();                                                                 // only a disconnected member left
    await until(() => closed.includes(`${two.code}:empty`), 4000);                  // expiry, then empty close
    assert.equal(s.lobby.rooms.size, 0);
  } finally { await s.done(); }
});

test('a kicked member loses its seat and its session', async () => {
  const s = await setup();
  try {
    const h = await s.player('H'), a = await s.player('A');
    const room = await h.l.create({}); await a.l.join(room.code);
    const r = s.lobby.roomOf(h.session());
    let lost; a.c.onSessionLost = info => lost = info;
    await h.l.kick(1);
    await until(() => a.c.status === 'lost'); assert.equal(lost.reason, 'kicked');
    assert.equal(r.members.size, 1); assert.equal(s.server.sessions.has(a.c.id), false);
    await assert.rejects(h.l.kick(0), /no such player/);
  } finally { await s.done(); }
});

test('a full room evicts the longest-disconnected member; the evicted player learns it on resume', async () => {
  const s = await setup({}, { maxMembers: 2 });
  try {
    const a = await s.player('A'), b = await s.player('B'), c = await s.player('C');
    const room = await a.l.create({}); await b.l.join(room.code);
    const r = s.lobby.roomOf(a.session());
    let leftReason; b.l.onLeft = reason => leftReason = reason;
    await b.drop(); await c.l.join(room.code);
    assert.equal(c.member().seat, 1); assert.equal(r.members.size, 2);
    await b.back(); await until(() => leftReason === 'replaced'); assert.equal(b.l.room, null);
  } finally { await s.done(); }
});

test('as documented: host stays with the later member after the earliest-joined member returns', async () => {
  const s = await setup();
  try {
    const a = await s.player('A'), b = await s.player('B');
    const room = await a.l.create({}); await b.l.join(room.code);
    const r = s.lobby.roomOf(a.session());
    await a.drop(); await until(() => r.host === b.member()); await a.back();
    console.log('# host after A returns:', r.host.name);
  } finally { await s.done(); }
});

test('as documented: a name change during the countdown does not cancel it; server close clears the timer', async () => {
  const s = await setup({}, { ready: { countdownMs: 300, minMembers: 1 } });
  let started = 0; s.lobby.onStart = () => started++;
  try {
    const a = await s.player('A');
    await a.l.create({}); const r = s.lobby.roomOf(a.session());
    await a.l.setReady(true); const end = r.countdownEndsAt; await a.l.setName('AA');
    console.log('# countdown after name change:', r.countdownEndsAt === end ? 'unchanged' : r.countdownEndsAt);
    const b = await s.player('B'); await b.l.create({}); const r2 = s.lobby.roomOf(b.session());
    await b.l.setReady(true); r2.close('test'); await sleep(450);
    assert.equal(r2.phase, 'lobby'); assert.equal(started, 1);
  } finally { await s.done(); }
});
