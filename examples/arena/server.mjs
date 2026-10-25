// Demonstrates a small social room. Not a competitive FPS simulation or an anti-cheat system.
import { createGameServer, createNativeRtcFactory } from '../../dist/server/index.js';
import { defineSchema, SpatialGrid } from '../../dist/netcode/index.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.env.PORT ?? 8787);
const allowed = (process.env.ALLOWED_ORIGINS ?? `http://127.0.0.1:${port},http://localhost:${port}`).split(',');
const move = defineSchema({ x: { type: 'f32' }, y: { type: 'f32' } });
const snap = defineSchema({ id: { type: 'u16' }, x: { type: 'f32' }, y: { type: 'f32' } });
const actors = new Map(), grid = new SpatialGrid(8); let nextId = 1;
const rtc = process.env.RTC === '1' ? await createNativeRtcFactory({ port: Number(process.env.RTC_PORT ?? 8788), publicIp: process.env.RTC_PUBLIC_IP }) : undefined;
const server = await createGameServer({
  port, host: process.env.HOST ?? '127.0.0.1', origins: allowed, rtc,
  endpoint: { bytesPerSecond: 12 * 1024 },
  onError: e => console.error('Peer error:', e.message),
  onSession(session, resumed) {
    let a = actors.get(session.id);
    if (!a) { a = { id: nextId++, x: 0, y: 0, last: performance.now(), sayAt: 0, room: session.room }; actors.set(session.id, a); }
    session.sendEvent({ t: 'identity', id: a.id, x: a.x, y: a.y, resumed });
    grid.upsert(a.id, a);
    session.onState = state => {
      if (state.stream !== 0) return;
      const input = move.decode(state.data); if (!input) return;
      const now = performance.now(), dt = Math.min(1, (now - a.last) / 1000);
      const x = Math.max(-20, Math.min(20, input.x)), y = Math.max(-14, Math.min(14, input.y));
      const dx = x - a.x, dy = y - a.y, distance = Math.hypot(dx, dy), allowed = 6 * dt + 0.1;
      if (distance > allowed) { a.x += dx * allowed / distance; a.y += dy * allowed / distance; session.sendEvent({ t: 'correction', x: a.x, y: a.y }); }
      else { a.x = x; a.y = y; }
      a.last = now; grid.upsert(a.id, a);
    };
    session.onEvent = data => {
      if (!data || typeof data !== 'object' || data.t !== 'chat' || typeof data.text !== 'string') return;
      if (performance.now() - a.sayAt < 500) return;
      a.sayAt = performance.now(); server.broadcast(a.room, { t: 'chat', id: a.id, text: data.text.slice(0, 200) });
    };
  },
  onExpire(session) {
    const a = actors.get(session.id); if (!a) return;
    actors.delete(session.id); grid.remove(a.id); server.broadcast(a.room, { t: 'leave', id: a.id });
  },
  http: async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ sessions: server.sessions.size, rtc: !!rtc, rssMB: Math.round(process.memoryUsage().rss / 1048576) })); return; }
      let file;
      if (url.pathname.startsWith('/dist/') && !url.pathname.startsWith('/dist/server/')) {
        file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
        if (!file.startsWith(root + '/dist/') || !file.endsWith('.js')) throw new Error('Invalid path');
      } else if (url.pathname === '/' || url.pathname === '/index.html') file = path.join(root, 'examples/arena/index.html');
      else { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html'); res.setHeader('Cache-Control', 'no-store');
      res.end(await readFile(file));
    } catch { res.writeHead(404); res.end(); }
  },
});
await server.listen();
const timer = setInterval(() => {
  for (const session of server.sessions.values()) {
    if (!session.connected) continue;
    const viewer = actors.get(session.id); if (!viewer) continue;
    const nearby = grid.query(viewer, 12);
    for (const a of actors.values()) if (a.room === viewer.room && nearby.has(a.id)) session.sendState(a.id, snap.encode(a), { ttlMs: 100 });
  }
}, 50);
console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}`, rtc: !!rtc }));
const stop = async () => { clearInterval(timer); await server.close(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
