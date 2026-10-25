import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameServer, Lobby } from '../dist/server/index.js';
import { GameClient, LobbyClient } from '../dist/client/index.js';
import { cleanName, cleanMeta, normalizeCode } from '../dist/core/lobby.js';
import { until, sleep } from './helpers.mjs';

async function setup(lobbyOptions = {}, serverOptions = {}) {
  const server = await createGameServer({ origins: [], allowMissingOrigin: true, resumeGraceMs: 400, ...serverOptions });
  const lobby = new Lobby(server, lobbyOptions);
  const port = await server.listen(), clients = [];
  const player = async (name, extra = {}) => {
    const client = new GameClient({ url: `ws://127.0.0.1:${port}/connect`, room: 'game', rtc: false, reconnectBaseMs: 10, auth: { name }, ...extra });
    const l = new LobbyClient(client); clients.push(client);
    client.connect(); await client.whenOnline(); return l;
  };
  const done = async () => { for (const c of clients) c.close(); lobby.dispose(); await server.close(); };
  return { server, lobby, player, done };
}

test('names, codes and meta are cleaned', () => {
  assert.equal(cleanName('  Wren‮\u0007  the\tBrave  '), 'Wren the Brave');
  assert.equal(cleanName('x'.repeat(40)).length, 16);
  assert.equal(normalizeCode(' abcd '), 'ABCD'); assert.equal(normalizeCode('a/b'), null);
  assert.deepEqual(cleanMeta({ build: 'abc', skin: 2 }), { build: 'abc', skin: 2 });
  assert.equal(cleanMeta({ __proto__x: 1, 'bad key': 1 }), null); assert.equal(cleanMeta([1]), null);
});

test('a private room is joined by code; everyone sees seats, names and the host', async () => {
  const t = await setup();
  try {
    const a = await t.player('ANA'), b = await t.player('BO');
    const room = await a.create({ mode: 'night', maxMembers: 3 });
    assert.match(room.code, /^[A-Z]{4}$/); assert.equal(room.visibility, 'private'); assert.equal(room.you, 0);
    const joined = await b.join(room.code.toLowerCase());
    assert.equal(joined.you, 1);
    await until(() => a.room?.members.length === 2);
    assert.deepEqual(a.room.members.map(m => [m.seat, m.name, m.host]), [[0, 'ANA', true], [1, 'BO', false]]);
    await assert.rejects(b.join('ZZZZ'), /no room called ZZZZ/);
    assert.equal(b.room.code, room.code, 'a failed join leaves the old room alone');
  } finally { await t.done(); }
});

test('quick play fills the fullest open public room of the same mode and build, never a private one', async () => {
  const t = await setup({ quickPlayPhases: ['lobby', 'playing'] });
  try {
    const a = await t.player('A'), b = await t.player('B'), c = await t.player('C'), d = await t.player('D');
    const priv = await a.create({ mode: 'night' });
    const pub = await b.quickPlay({ mode: 'night', match: { build: 'v1' } });
    assert.notEqual(pub.code, priv.code); assert.equal(pub.visibility, 'public'); assert.equal(pub.meta.build, 'v1');
    const same = await c.quickPlay({ mode: 'night', match: { build: 'v1' } });
    assert.equal(same.code, pub.code);
    const other = await d.quickPlay({ mode: 'night', match: { build: 'v2' } });
    assert.notEqual(other.code, pub.code, 'another build never shares a room');
  } finally { await t.done(); }
});

test('ready-up counts down when every connected member is ready, and an unready cancels it', async () => {
  let started = 0;
  const t = await setup({ ready: { countdownMs: 150, minMembers: 2 } });
  t.lobby.onStart = () => started++;
  try {
    const a = await t.player('A'), b = await t.player('B');
    const room = await a.create(); await b.join(room.code);
    await a.setReady(true); await sleep(30); assert.equal(a.room.countdownEndsAt, null, 'one of two is not enough');
    await b.setReady(true); await until(() => a.room.countdownEndsAt !== null);
    assert.ok(a.countdownMs() > 0 && a.countdownMs() <= 150);
    await b.setReady(false); await until(() => a.room.countdownEndsAt === null);
    await sleep(200); assert.equal(started, 0);
    await b.setReady(true); await until(() => a.room.phase === 'playing' && b.room.phase === 'playing');
    assert.equal(started, 1); assert.ok(a.room.members.every(m => !m.ready));
    await assert.rejects(a.setReady(true), /already running/);
  } finally { await t.done(); }
});

test('a dropped player keeps the seat and comes back to it; the host passes on while they are away', async () => {
  const events = [];
  const t = await setup();
  t.lobby.onDisconnect = (r, m) => events.push(['away', m.seat]); t.lobby.onReconnect = (r, m) => events.push(['back', m.seat]);
  try {
    const a = await t.player('A'), b = await t.player('B');
    const room = await a.create(); await b.join(room.code);
    a.client.pause();
    await until(() => b.room.members.find(m => m.seat === 0)?.connected === false);
    assert.equal(b.room.members.find(m => m.seat === 1).host, true, 'host moved to the connected player');
    a.client.resume(); await a.client.whenOnline();
    await until(() => b.room.members.find(m => m.seat === 0)?.connected === true);
    assert.equal(a.room.you, 0); assert.deepEqual(events, [['away', 0], ['back', 0]]);
  } finally { await t.done(); }
});

test('a session that expires leaves its room; an empty room closes', async () => {
  let closed = null;
  const t = await setup({ emptyCloseMs: 0 });
  t.lobby.onClose = (r, why) => closed = why;
  try {
    const a = await t.player('A');
    const room = await a.create();
    a.client.pause();
    await until(() => !t.lobby.rooms.get(room.code)?.members.size, 3000);
    await until(() => closed === 'empty', 3000);
  } finally { await t.done(); }
});

test('a full room frees the seat of whoever has been gone longest; otherwise it refuses', async () => {
  const t = await setup({ maxMembers: 2 });
  try {
    const a = await t.player('A'), b = await t.player('B'), c = await t.player('C');
    const room = await a.create(); await b.join(room.code);
    await assert.rejects(c.join(room.code), /full/);
    let left; b.onLeft = r => left = r;
    b.client.pause(); await until(() => a.room.members.some(m => !m.connected));
    const r = await c.join(room.code); assert.equal(r.you, 1);
    b.client.resume(); await b.client.whenOnline(); await until(() => left === 'replaced');
    assert.equal(b.room, null);
  } finally { await t.done(); }
});

test('the host can kick; others cannot; a kicked session is ended', async () => {
  const t = await setup();
  try {
    const a = await t.player('A'), b = await t.player('B');
    const room = await a.create(); await b.join(room.code);
    await assert.rejects(b.kick(0), /only the host/);
    let lost = null; b.client.onSessionLost = i => lost = i.reason;
    await a.kick(1);
    await until(() => lost === 'kicked'); await until(() => a.room.members.length === 1);
  } finally { await t.done(); }
});

test('application events and states reach the lobby with their room and member', async () => {
  const seen = [];
  const t = await setup();
  t.lobby.onEvent = (room, member, data) => { seen.push([room?.code ?? null, member?.seat ?? null, data]); if (room) room.broadcast({ echo: data }, member); };
  try {
    const a = await t.player('A'), b = await t.player('B'), got = [];
    b.client.onEvent = d => got.push(d);
    a.client.sendEvent({ hello: 'outside' });
    const room = await a.create(); await b.join(room.code);
    a.client.sendEvent({ hello: 'room' });
    await until(() => got.length === 1);
    assert.deepEqual(seen, [[null, null, { hello: 'outside' }], [room.code, 0, { hello: 'room' }]]);
    assert.deepEqual(got, [{ echo: { hello: 'room' } }], 'lobby messages never reach onEvent');
  } finally { await t.done(); }
});

test('canCreate/canJoin can refuse; room creation is rate limited per address', async () => {
  const t = await setup({ maxRoomsPerIpPerHour: 2, canJoin: (room, s, req) => req.memberMeta?.build !== room.meta.build ? 'reload the page' : null });
  try {
    const a = await t.player('A'), b = await t.player('B');
    const room = await a.create({ meta: { build: 'x' } });
    await assert.rejects(b.join(room.code, { memberMeta: { build: 'y' } }), /reload the page/);
    await b.join(room.code, { memberMeta: { build: 'x' } });
    await b.create(); await assert.rejects(b.create(), /too many rooms/);
  } finally { await t.done(); }
});

test('leave asks the server and clears the view; member meta updates reach everyone', async () => {
  const t = await setup();
  try {
    const a = await t.player('A'), b = await t.player('B');
    const room = await a.create(); await b.join(room.code);
    await b.setMeta({ skin: 3 }); await until(() => a.room.members[1]?.meta.skin === 3);
    await b.setName('BEE'); await until(() => a.room.members[1]?.name === 'BEE');
    await b.leave(); assert.equal(b.room, null); await until(() => a.room.members.length === 1);
  } finally { await t.done(); }
});

test('a create request carries setup data to onCreate; origin predicates are honoured', async () => {
  let init = null;
  const t = await setup({}, { origins: o => o === 'https://ok.example' });
  t.lobby.onCreate = (room, creator, req) => { init = req.init; room.data = { save: req.init }; };
  try {
    const a = await t.player('A');
    const room = await a.create({ mode: 'story', init: { save: { v: 2, hp: 10 }, course: 'x'.repeat(20000) } });
    assert.equal(init.save.hp, 10); assert.equal(init.course.length, 20000);
    assert.equal(JSON.stringify(a.room).includes('xxxx'), false, 'setup data is not echoed to members');
    assert.equal(t.lobby.rooms.get(room.code).data.save.save.v, 2);
  } finally { await t.done(); }
});

test('simulateDrop reconnects into the same session', async () => {
  const t = await setup();
  try {
    const a = await t.player('A'); const id = a.client.id; await a.create();
    a.client.simulateDrop(); await until(() => a.client.status === 'connecting'); await a.client.whenOnline();
    assert.equal(a.client.id, id); assert.equal(a.room.you, 0);
  } finally { await t.done(); }
});

test('clients set only the meta keys the server allows, within a size cap', async () => {
  const t = await setup({ clientMetaKeys: ['skin'] });
  t.lobby.onJoin = (room, m) => { m.meta = { ...m.meta, pid: 7 }; };
  try {
    const a = await t.player('A');
    await a.create({ memberMeta: { skin: 1, pid: 99 } });
    assert.deepEqual(a.me.meta, { skin: 1, pid: 7 });
    await a.setMeta({ pid: 1, skin: 2 }); assert.deepEqual(a.me.meta, { skin: 2, pid: 7 });
    const t2 = await setup();
    try {
      const b = await t2.player('B'); await b.create();
      for (let i = 0; i < 3; i++) await b.setMeta(Object.fromEntries(Array.from({ length: 10 }, (_, j) => ['k' + i + '_' + j, j])));
      await assert.rejects(b.setMeta({ more: 1, again: 2, and: 3 }), /too much meta/);
    } finally { await t2.done(); }
  } finally { await t.done(); }
});

test('a reloaded page that takes over its still-open session is a reconnect too', async () => {
  const back = [];
  const t = await setup();
  t.lobby.onReconnect = (room, m) => back.push(m.seat);
  try {
    const a = await t.player('A'); await a.create();
    // the old page is still connected when the new one resumes its checkpoint
    const cp = a.client.checkpoint();
    const url = a.client.options.url;
    const fresh = new (a.client.constructor)({ url, room: 'game', rtc: false, checkpoint: cp });
    const l2 = new LobbyClient(fresh); fresh.connect(); await fresh.whenOnline();
    await until(() => back.length === 1); assert.deepEqual(back, [0]);
    await until(() => l2.room?.you === 0);
    fresh.close();
  } finally { await t.done(); }
});
