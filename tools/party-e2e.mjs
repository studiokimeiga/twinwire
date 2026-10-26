// The party example, played: two players in real browsers (ENGINES=chromium,firefox,webkit) meet by quick play and code,
// ready up, move (the other sees it, and your own prediction agrees with the server), and chat.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 21000 + Math.floor(Math.random() * 9000);
const srv = spawn(process.execPath, ['examples/party/server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { srv.stdout.on('data', d => /"ready":true/.test(d) && res()); srv.on('exit', c => rej(new Error('server exited ' + c))); });
const url = `http://127.0.0.1:${port}/`, engines = (process.env.ENGINES ?? 'chromium,firefox,webkit').split(',');
const wait = (p, fn, arg, ms = 15000) => p.waitForFunction(fn, arg, { timeout: ms, polling: 50 });
let failed = false;
try {
  for (const name of engines) {
    const browser = await { chromium, firefox, webkit }[name].launch();
    try {
      const errors = [], open = async () => { const p = await (await browser.newContext()).newPage(); p.on('pageerror', e => errors.push(String(e))); await p.goto(url); return p; };
      const a = await open(), b = await open();
      await a.fill('#name', 'ANA'); await a.click('#create');
      await wait(a, () => document.querySelector('#roomcode').textContent.length === 4);
      const code = await a.textContent('#roomcode');
      await b.fill('#name', 'BO'); await b.fill('#code', code.toLowerCase()); await b.click('#join');
      await wait(a, () => document.querySelectorAll('#members li').length === 2);
      await a.click('#ready'); await b.click('#ready');
      await wait(a, () => __party.lobby.room?.phase === 'playing' && __party.me, null, 20000);
      await wait(b, () => __party.lobby.room?.phase === 'playing' && __party.me && __party.others.size === 1, null, 20000);
      const x0 = await a.evaluate(() => __party.me.state.x);
      await a.keyboard.down('d'); await a.waitForTimeout(800); await a.keyboard.up('d'); await a.waitForTimeout(600);
      const ax = await a.evaluate(() => __party.me.state.x);
      // what B draws for A (interpolated) is where A predicts itself, once A stops
      const bx = await b.evaluate(() => { const [tl] = __party.others.values(); return tl.sample(1e15, (p, q) => p).value.x; });
      if (!(ax - x0 > 80)) throw new Error(`A did not move (${x0} -> ${ax})`);
      if (Math.abs(bx - ax) > 1) throw new Error(`B sees A at ${bx}, A is at ${ax}`);
      await b.fill('#say', 'hello from bo'); await b.click('#chat button');
      await wait(a, () => document.querySelector('#log').textContent.includes('BO: hello from bo'));
      // The shared receiver resets buffers automatically on resume, then waits for usable current state.
      const before = await b.evaluate(() => [__party.client.id, __party.lobby.room.you]);
      await b.evaluate(() => { __party.client.pause(); if (__party.snapshots.ready) throw Error('offline replay is ready'); });
      await b.evaluate(() => __party.client.resume());
      await wait(b, () => __party.snapshots.ready && __party.me && __party.others.size === 1);
      const after = await b.evaluate(() => [__party.client.id, __party.lobby.room.you]);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('resume changed session or seat');
      if (errors.length) throw new Error('page errors: ' + errors.join(' | '));
      console.log(JSON.stringify({ engine: name, code, moved: Math.round(ax - x0), agree: Math.abs(bx - ax).toFixed(2), transport: await a.evaluate(() => __party.client.transport), receiverResume: true, pass: true }));
    } catch (e) { failed = true; console.log(JSON.stringify({ engine: name, pass: false, error: String(e.message).split('\n')[0] })); }
    finally { await browser.close(); }
  }
} finally { srv.kill(); }
process.exit(failed ? 1 : 0);
