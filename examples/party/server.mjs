// Twinwire party: a complete little multiplayer game. Quick play or a private room by code, ready up, then move around a
// shared arena and chat. The server owns the world (it runs every move); each browser predicts its own player and
// interpolates everyone else. Run: npm run build && node examples/party/server.mjs, then open http://127.0.0.1:8790 in
// two tabs (or phones on your network with HOST=0.0.0.0). RTC=1 adds WebRTC datagrams (needs node-datachannel).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGameServer, createNativeRtcFactory, Lobby } from 'twinwire/server';
import { InputInbox, decodeInputs } from 'twinwire/netcode';
import { move, spawn, inputCodec, encodeSnapshot, TICK_HZ, SNAP_HZ } from './shared.js';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '../..');
const port = Number(process.env.PORT ?? 8790), host = process.env.HOST ?? '127.0.0.1';
const files = { '/': [path.join(HERE, 'index.html'), 'text/html'], '/shared.js': [path.join(HERE, 'shared.js'), 'text/javascript'],
  '/twinwire.mjs': [path.join(ROOT, 'dist/browser/twinwire.mjs'), 'text/javascript'] };

const server = await createGameServer({
  port, host,
  origins: o => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(o),   // this machine and your network
  rtc: process.env.RTC === '1' ? await createNativeRtcFactory({ port: Number(process.env.RTC_PORT ?? port + 1) }) : undefined,
  onError: e => console.error('peer:', e.message),
  http: async (req, res) => {
    const f = files[new URL(req.url ?? '/', 'http://x').pathname];
    if (!f) { res.writeHead(404); res.end(); return; }
    try { res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-store' }); res.end(await readFile(f[0])); }
    catch { res.writeHead(404); res.end(); }
  },
});
const lobby = new Lobby(server, {
  maxMembers: 8,
  ready: { countdownMs: 3000, minMembers: 1 },
  joinablePhases: ['lobby', 'playing'],            // friends can join by code mid-game
  quickPlayPhases: ['lobby', 'playing'],           // and quick play fills games in progress too
  clientMetaKeys: [],                              // seats and colours are the server's to give
});

// each room's world: a player per seat, moved only by the server
lobby.onCreate = room => { room.data = { tick: 0, players: new Map() }; };
lobby.onJoin = (room, m) => {
  m.data = { ...spawn(m.seat), seat: m.seat, inbox: new InputInbox(), last: { dx: 0, dy: 0 }, newest: 0 };
  room.data.players.set(m.seat, m.data);
  room.broadcast({ t: 'chat', from: '', text: `${m.name} joined` });
};
lobby.onLeave = (room, m) => { room.data?.players.delete(m.seat); room.broadcast({ t: 'chat', from: '', text: `${m.name} left` }); };
lobby.onStart = room => room.broadcast({ t: 'chat', from: '', text: 'GO!' });
// inputs arrive as bundles of the last few (stream 1); each is queued once, in order
lobby.onState = (room, m, st) => {
  if (!m?.data || st.stream !== 1) return;
  for (const i of decodeInputs(st.data) ?? []) {
    const v = inputCodec.decode(i.data); if (!v) continue;
    m.data.inbox.add({ seq: i.seq, value: v }); m.data.newest = Math.max(m.data.newest, i.seq);
  }
};
// chat is an acknowledged event; validate it, then pass it on
lobby.onEvent = (room, m, data) => {
  if (!room || !m || !data || data.t !== 'chat' || typeof data.text !== 'string') return;
  const text = data.text.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (text) room.broadcast({ t: 'chat', from: m.name, seat: m.seat, text });
};

// the world: 60 steps a second, a snapshot to everyone 20 times a second
const every = TICK_HZ / SNAP_HZ;
setInterval(() => {
  for (const room of lobby.rooms.values()) {
    const W = room.data; if (!W || room.phase !== 'playing') continue;
    W.tick++;
    for (const p of W.players.values()) {
      // far behind (a stall, a burst after a hiccup)? jump to the newest few rather than replay old movement
      if (p.newest - p.inbox.applied > 10) p.inbox.skipThrough(p.newest - 3);
      const i = p.inbox.next();
      if (i) p.last = i.value;
      Object.assign(p, move(p, i ? i.value : p.last, 1 / TICK_HZ));
    }
    if (W.tick % every) continue;
    const list = [...W.players.values()];
    for (const m of room.members.values()) if (m.connected && m.data) m.session.sendState(0, encodeSnapshot(W.tick, m.data.inbox.applied, list), { ttlMs: 100 });
  }
}, 1000 / TICK_HZ);

await server.listen();
console.log(JSON.stringify({ ready: true, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`, rtc: !!server.options.rtc }));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { lobby.dispose(); await server.close(); process.exit(0); });
