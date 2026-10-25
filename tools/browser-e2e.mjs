// Real browsers against a real server: Chromium, Firefox and WebKit (Safari's engine) each open two players, meet in a
// lobby by code, ready up, then exchange state, events and a large snapshot over real WebRTC to the native
// node-datachannel server, with the WebSocket path checked too. Writes validation/browsers.json.
// ENGINES=chromium,webkit to pick; RTC=0 to run WebSocket only. Requires node-datachannel (a dev dependency).
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { createGameServer, createNativeRtcFactory, Lobby } from '../dist/server/index.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engines = (process.env.ENGINES ?? 'chromium,firefox,webkit').split(',');
const useRtc = process.env.RTC !== "0";
const impair = process.env.IMPAIR ? { lagMs: 40, jitterMs: 20, loss: 0.05 } : null;
const udp = 20000 + Math.floor(Math.random() * 20000);
const rtc = useRtc ? await createNativeRtcFactory({ port: udp }) : undefined;
const bundle = await readFile(path.join(root, 'dist/browser/twinwire.js'));
const page = `<!doctype html><meta charset="utf-8"><title>e2e</title><script src="/twinwire.js"></script><script>
window.T = {
  got: [], events: [], start(rtc, impair) {
    const c = this.client = new Twinwire.GameClient({ url: 'ws://' + location.host + '/connect', room: 'e2e', rtc: rtc ? {} : false, auth: { name: 'P' + Math.floor(Math.random() * 99) }, impair });
    this.lobby = new Twinwire.LobbyClient(c);
    c.onState = s => this.got.push({ stream: s.stream, via: s.via, n: s.data.length, first: s.data[0] });
    c.onEvent = d => this.events.push(d);
    c.connect(); return true;
  },
  async burst(stream, count, size, hz) {
    for (let i = 0; i < count; i++) { const b = new Uint8Array(size); b[0] = i % 256; this.client.sendState(stream, b); this.client.flush(); await new Promise(r => setTimeout(r, 1000 / hz)); }
  },
};
</script>`;
const http = (req, res) => {
  if (req.url === '/twinwire.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle); return; }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(page);
};
let origin = '';
const server = await createGameServer({ origins: [], allowMissingOrigin: false, rtc, http, resumeGraceMs: 20000, allowImpairment: !!impair,
  onError: e => { if (!/closed|aborted/i.test(e.message)) console.error('server:', e.message); } });
const port = await server.listen(); origin = `http://127.0.0.1:${port}`; server.options.origins.push(origin);
const lobby = new Lobby(server, { ready: { countdownMs: 400, minMembers: 2 } });
lobby.onState = (room, member, st) => { if (room) for (const m of room.members.values()) if (m !== member && m.connected) m.session.sendState(st.stream, st.data); };
lobby.onEvent = (room, member, data) => { room?.broadcast({ from: member.seat, data }, member); };
const results = [];
const wait = (p, fn, arg, ms = 15000) => p.waitForFunction(fn, arg, { timeout: ms, polling: 50 });
try {
  for (const name of engines) {
    const type = { chromium, firefox, webkit }[name];
    const result = { engine: name, rtcRequested: useRtc, impaired: impair };
    let browser;
    try {
      browser = await type.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
      result.version = browser.version();
      const phone = name === 'firefox' ? { viewport: { width: 390, height: 844 }, hasTouch: true } :
        { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 };
      const [ca, cb] = [await browser.newContext(), await browser.newContext(phone)];
      const [a, b] = [await ca.newPage(), await cb.newPage()];
      const errors = []; for (const p of [a, b]) p.on('pageerror', e => errors.push(String(e)));
      for (const p of [a, b]) { await p.goto(origin + '/'); await p.evaluate(([r, i]) => T.start(r, i ?? undefined), [useRtc, impair]); await wait(p, () => T.client.status === 'online'); }
      // lobby: a private room by code, both ready, countdown, playing
      const code = await a.evaluate(async () => (await T.lobby.create({ mode: 'e2e' })).code);
      await b.evaluate(c => T.lobby.join(c), code);
      await wait(a, () => T.lobby.room?.members.length === 2);
      await a.evaluate(() => T.lobby.setReady(true)); await b.evaluate(() => T.lobby.setReady(true));
      await wait(a, () => T.lobby.room?.countdownEndsAt != null || T.lobby.room?.phase === 'playing');
      await wait(b, () => T.lobby.room?.phase === 'playing'); await wait(a, () => T.lobby.room?.phase === 'playing');
      result.lobby = { code, readyCountdown: true, phase: 'playing' };
      // transport
      if (useRtc) {
        try { await wait(a, () => T.client.transport === 'rtc', null, 12000); await wait(b, () => T.client.transport === 'rtc', null, 12000); result.transport = 'rtc'; }
        catch { result.transport = await a.evaluate(() => T.client.transport) + '/' + await b.evaluate(() => T.client.transport); }
      } else result.transport = 'ws';
      // 60 small states at 30 Hz a -> server -> b
      await a.evaluate(() => T.burst(1, 60, 64, 30));
      await wait(b, () => T.got.filter(g => g.stream === 1).length >= 40);
      const small = await b.evaluate(() => T.got.filter(g => g.stream === 1));
      result.smallStates = { sent: 60, received: small.length, viaRtc: small.filter(g => g.via === 'rtc').length };
      // a 50 KB snapshot
      await a.evaluate(() => T.burst(2, 1, 50000, 30));
      await wait(b, () => T.got.some(g => g.stream === 2 && g.n === 50000));
      result.largeState = { bytes: 50000, via: await b.evaluate(() => T.got.find(g => g.stream === 2).via) };
      // events, both ways
      await a.evaluate(() => T.client.sendEvent({ shot: 1 })); await b.evaluate(() => T.client.sendEvent({ shot: 2 }));
      await wait(b, () => T.events.some(e => e.data?.shot === 1)); await wait(a, () => T.events.some(e => e.data?.shot === 2));
      result.events = true;
      // phone backgrounded: pause, resume, same seat in the same room
      const before = await b.evaluate(() => [T.client.id, T.lobby.room.you]);
      await b.evaluate(() => T.client.pause()); await wait(a, () => T.lobby.room.members.some(m => !m.connected));
      await b.evaluate(() => T.client.resume()); await wait(b, () => T.client.status === 'online');
      await wait(a, () => T.lobby.room.members.every(m => m.connected));
      const after = await b.evaluate(() => [T.client.id, T.lobby.room?.you]);
      result.resume = { sameSession: before[0] === after[0], sameSeat: before[1] === after[1] };
      if (useRtc) { try { await wait(b, () => T.client.transport === 'rtc', null, 12000); result.rtcAfterResume = true; } catch { result.rtcAfterResume = false; } }
      result.pageErrors = errors;
      result.pass = !errors.length && result.smallStates.received >= 40 && result.events && result.resume.sameSession && result.resume.sameSeat &&
        (!useRtc || name !== 'chromium' || result.transport === 'rtc');
    } catch (e) { result.pass = false; result.error = String(e?.message ?? e).split('\n')[0]; }
    finally { await browser?.close(); }
    results.push(result); console.log(JSON.stringify(result));
  }
} finally { lobby.dispose(); await server.close(); }
await mkdir(path.join(root, 'validation'), { recursive: true });
await writeFile(path.join(root, impair ? "validation/browsers-impaired.json" : useRtc ? "validation/browsers.json" : "validation/browsers-ws.json"), JSON.stringify({ at: new Date().toISOString(), node: process.version, results }, null, 2) + '\n');
if (results.some(r => !r.pass)) { console.error('Browser E2E failed'); process.exit(1); }
process.exit(0);
