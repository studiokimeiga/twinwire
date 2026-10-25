// Soak: a Lobby server under churn and hostile traffic for a while, watching for leaks, stalls and lost events.
// The server runs here; honest and hostile clients run in a worker thread, so the heap measured is the server's.
//   npm run build && node --expose-gc tools/soak.mjs [--minutes 10] [--clients 48] [--hostile 6]
// Honest clients live short lives in rooms: states at 20 Hz, events echoed back by the server (checked exactly once and
// in order), and every few seconds a disruption (a clean close, a socket killed without a goodbye, a pause shorter or
// longer than the resume grace, a new room). Hostile clients send garbage, floods, oversized frames, forged resumes
// and idle sockets. At the end every session, connection and room must be gone and the heap must not have grown.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const option = (name, value) => { const i = process.argv.indexOf(name); return i < 0 ? value : Number(process.argv[i + 1]); };
const GRACE_MS = 4000, EMPTY_CLOSE_MS = 2000;

if (isMainThread) {
  if (typeof global.gc !== 'function') throw new Error('run with node --expose-gc');
  const minutes = option('--minutes', 10), clients = option('--clients', 48), hostile = option('--hostile', 6);
  const { createGameServer, Lobby } = await import('../dist/server/index.js');
  const resourcesBefore = countResources();
  const errors = [], serverErrors = [];
  const server = await createGameServer({ origins: [], allowMissingOrigin: true, maxSessions: 2000, maxConnections: 2000,
    maxPerIp: 2000, resumeGraceMs: GRACE_MS, onError: e => serverErrors.push(e.message) });
  const lobby = new Lobby(server, { maxMembers: 4, emptyCloseMs: EMPTY_CLOSE_MS, maxRoomsPerIpPerHour: 1e9,
    joinablePhases: ['lobby', 'playing'], quickPlayPhases: ['lobby', 'playing'], ready: { countdownMs: 500, minMembers: 2 } });
  let echoed = 0, relayed = 0;
  lobby.onEvent = (room, member, data, session) => {
    if (data && data.t === 'echo') { session.sendEvent({ t: 'echo', n: data.n }); echoed++; }
    if (room && member && data && data.t === 'chat') room.broadcast({ t: 'chat', from: member.seat }, member);
  };
  lobby.onState = (room, member, state) => {
    if (!room || !member) return;
    for (const m of room.members.values()) if (m !== member && m.connected) { m.session.sendState(member.seat, state.data, { ttlMs: 200 }); relayed++; }
  };
  const port = await server.listen();
  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
  const samples = [], t0 = Date.now();
  const sample = () => {
    const p99 = lag.percentile(99) / 1e6, max = lag.max / 1e6; lag.reset();
    global.gc(); const m = server.metrics(), mem = process.memoryUsage();
    samples.push({ s: Math.round((Date.now() - t0) / 1000), heapMB: +(mem.heapUsed / 1048576).toFixed(2), rssMB: +(mem.rss / 1048576).toFixed(1),
      sessions: m.sessions, connections: m.connections, rooms: lobby.rooms.size, lagP99: +p99.toFixed(1), lagMax: +max.toFixed(1),
      protocolErrors: m.protocolErrors ?? null, echoed, relayed });
    const last = samples[samples.length - 1];
    console.log(`${String(last.s).padStart(5)}s heap ${last.heapMB} MB  rss ${last.rssMB}  sessions ${last.sessions}  conns ${last.connections}  rooms ${last.rooms}  lag p99 ${last.lagP99} ms  echoed ${echoed}`);
  };
  const timer = setInterval(sample, 10000);
  const worker = new Worker(new URL(import.meta.url), { workerData: { port, minutes, clients, hostile } });
  const report = await new Promise((resolve, reject) => { worker.on('message', resolve); worker.on('error', reject); });
  await worker.terminate();
  // everything the clients left behind must expire: resume grace, then empty rooms
  await new Promise(r => setTimeout(r, GRACE_MS + EMPTY_CLOSE_MS + 3000));
  sample(); clearInterval(timer);
  const end = samples[samples.length - 1];
  // heap: compare the middle of the run with its end (after warm-up, both under the same load)
  const steady = samples.filter(s => s.s >= 60 && s !== end), half = Math.floor(steady.length / 2);
  const median = a => { const b = a.map(s => s.heapMB).sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
  const heapMid = median(steady.slice(0, half)), heapLate = median(steady.slice(half));
  const lagWorst = Math.max(...samples.slice(0, -1).map(s => s.lagP99));
  lag.disable(); lobby.dispose(); await server.close();
  await new Promise(r => setTimeout(r, 200));
  const resourcesAfter = countResources();
  const checks = {
    'no lost, duplicated or reordered echo in a session that lived': report.honest.dup === 0 && report.honest.gaps === 0 && report.honest.missing === 0,
    'every honest life got online': report.honest.neverOnline === 0,
    'sessions, connections and rooms all expired': end.sessions === 0 && end.connections === 0 && end.rooms === 0,
    'heap did not grow under steady load (late median within 10% + 3 MB of mid)': steady.length < 4 || heapLate <= heapMid * 1.1 + 3,
    'event loop p99 stayed under 50 ms': lagWorst < 50,
    // (PipeWrap is the worker thread's stdio, not the server)
    'no timers or sockets left after close': Object.keys(resourcesAfter).filter(k => k !== 'total' && k !== 'PipeWrap')
      .every(k => resourcesAfter[k] <= (resourcesBefore[k] ?? 0)),
    'no unexpected server errors': serverErrors.filter(m => !/protocol|invalid|too large|rate|limit|origin|malformed|unexpected|closed/i.test(m)).length === 0,
  };
  const result = { minutes, clients, hostile, node: process.version, honest: report.honest, hostileReport: report.hostile, heapMid, heapLate,
    lagWorstP99: lagWorst, end, resourcesBefore, resourcesAfter, serverErrorSamples: [...new Set(serverErrors)].slice(0, 12), checks };
  console.log(JSON.stringify(result, null, 2));
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  console.log(failed.length ? 'SOAK FAIL: ' + failed.join('; ') : 'SOAK PASS');
  process.exit(failed.length ? 1 : 0);
} else {
  const { GameClient, LobbyClient } = await import('../dist/client/index.js');
  const { default: WS } = await import('ws');
  const { port, minutes, clients, hostile } = workerData, url = `ws://127.0.0.1:${port}/connect`;
  const deadline = Date.now() + minutes * 60000, sleep = ms => new Promise(r => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a), pick = a => a[Math.floor(Math.random() * a.length)];
  const honest = { lives: 0, sessionsLost: 0, eventsSent: 0, eventsEchoed: 0, dup: 0, gaps: 0, missing: 0, neverOnline: 0, statesReceived: 0,
    disruptions: {}, lobbyErrors: {} };
  const hostileStats = {};
  const count = (o, k) => { o[k] = (o[k] || 0) + 1; };

  async function life(id) {
    let raw;
    const c = new GameClient({ url, room: 'soak', rtc: false, auth: { name: 'P' + id },
      websocket: u => (raw = new WS(u)) });
    const lobby = new LobbyClient(c);
    let sent = 0, last = 0, lost = false;
    c.onEvent = d => { if (d && d.t === 'echo') { if (d.n <= last) honest.dup++; else if (d.n !== last + 1) honest.gaps++; last = Math.max(last, d.n); honest.eventsEchoed++; } };
    c.onState = () => { honest.statesReceived++; };
    c.onSessionLost = () => { lost = true; };
    honest.lives++;
    c.connect();
    try { await Promise.race([c.whenOnline(), sleep(10000).then(() => { throw new Error('online timeout'); })]); }
    catch { honest.neverOnline++; c.close(); return; }
    try { await lobby.quickPlay({ mode: 'soak', create: { maxMembers: 4 } }); } catch (e) { count(honest.lobbyErrors, e.message); }
    const end = Date.now() + rnd(5000, 40000);
    let nextEvent = 0, nextDisrupt = Date.now() + rnd(2000, 8000), ending = 'close';
    while (Date.now() < end && Date.now() < deadline && !lost) {
      const b = new Uint8Array(24); new DataView(b.buffer).setFloat64(0, Date.now(), true); c.sendState(0, b);
      if (Date.now() >= nextEvent) { try { c.sendEvent({ t: 'echo', n: ++sent }); honest.eventsSent++; } catch { sent--; } nextEvent = Date.now() + 250; }
      if (Math.random() < 0.02) { try { c.sendEvent({ t: 'chat' }); } catch {} }
      if (Date.now() >= nextDisrupt) {
        const d = pick(['drop', 'kill', 'pause', 'longpause', 'room', 'ready', 'garbage']); count(honest.disruptions, d);
        if (d === 'drop') c.simulateDrop();
        else if (d === 'kill') raw?.terminate();
        else if (d === 'pause') { c.pause(); await sleep(rnd(200, GRACE_MS * 0.6)); c.resume(); }
        else if (d === 'longpause') { c.pause(); await sleep(GRACE_MS + 1500); c.resume(); }
        else if (d === 'room') { try { await lobby.leave(); await lobby.quickPlay({ mode: 'soak', create: { maxMembers: 4 } }); } catch (e) { count(honest.lobbyErrors, e.message); } }
        else if (d === 'ready') { try { await lobby.setReady(!lobby.me?.ready); } catch (e) { count(honest.lobbyErrors, e.message); } }
        else if (d === 'garbage') { ending = 'garbage'; try { raw?.send(new Uint8Array(64).map(() => Math.random() * 256)); } catch {} }
        nextDisrupt = Date.now() + rnd(2000, 8000);
      }
      await sleep(50);
    }
    if (lost) { honest.sessionsLost++; c.close(); return; }
    // let the echoes catch up, then check nothing is missing
    const settle = Date.now() + 8000;
    while (last < sent && Date.now() < settle && !lost) await sleep(50);
    if (lost) { honest.sessionsLost++; c.close(); return; }
    if (last < sent) honest.missing += sent - last;
    if (Math.random() < 0.15) { raw?.terminate(); c.pause(); } // abandon (a tab killed): the server must expire it
    else c.close();
  }

  async function actor(id) { while (Date.now() < deadline) { await life(id); await sleep(rnd(50, 1000)); } }

  async function attack() {
    while (Date.now() < deadline) {
      const kind = pick(['bytes', 'text', 'huge', 'flood', 'idle', 'forged', 'burst', 'json']); count(hostileStats, kind);
      await new Promise(done => {
        const ws = new WS(url); let finished = false;
        const finish = () => { if (!finished) { finished = true; try { ws.terminate(); } catch {} done(); } };
        ws.on('error', finish); ws.on('close', finish); setTimeout(finish, kind === 'idle' ? 15000 : 4000);
        ws.on('open', async () => {
          try {
            if (kind === 'bytes') for (let i = 0; i < 40; i++) ws.send(new Uint8Array(Math.floor(rnd(1, 2000))).map(() => Math.random() * 256));
            else if (kind === 'text') for (let i = 0; i < 40; i++) ws.send(Math.random().toString(36).repeat(Math.floor(rnd(1, 100))));
            else if (kind === 'huge') ws.send(new Uint8Array(2 * 1024 * 1024));
            else if (kind === 'flood') for (let i = 0; i < 3000; i++) ws.send('{"t":"x"}');
            else if (kind === 'forged') ws.send(JSON.stringify({ t: 'hello', v: 3, room: 'soak', resume: { id: 'x'.repeat(16), token: 'y'.repeat(43) } }));
            else if (kind === 'json') ws.send(JSON.stringify({ t: 'hello', v: 3, room: 'soak', auth: { a: '['.repeat(5000) }, nested: JSON.parse('['.repeat(500) + ']'.repeat(500)) }));
            else if (kind === 'burst') { const extra = Array.from({ length: 40 }, () => new WS(url)); await sleep(500); for (const e of extra) { e.on('error', () => {}); e.terminate(); } }
          } catch {}
        });
      });
      await sleep(rnd(20, 300));
    }
  }

  const tasks = [];
  for (let i = 0; i < clients; i++) { tasks.push(actor(i)); await sleep(30); }
  for (let i = 0; i < hostile; i++) tasks.push(attack());
  await Promise.all(tasks);
  await sleep(500);
  parentPort.postMessage({ honest, hostile: hostileStats });
}

function countResources() {
  const r = process.getActiveResourcesInfo(), out = { total: r.length };
  for (const k of r) out[k] = (out[k] || 0) + 1;
  out.Timeout ??= 0; return out;
}
