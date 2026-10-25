// Checks the built site in Chromium: every page at 1280 and 390 px wide, light and dark, with no console errors and no
// sideways scrolling; then each explainer animates and answers its controls. Screenshots go to website/.screens/.
// Usage (from website/): npm run build && npm run check
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)), SHOTS = ROOT + '.screens/', PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}/twinwire/`;
mkdirSync(SHOTS, { recursive: true });
const PAGES = ['', 'guide/getting-started', 'guide/party', 'how/sessions', 'how/two-wires', 'how/interpolation', 'how/prediction',
  'how/deltas', 'how/interest', 'how/lobby', 'reference/api/', 'reference/api/client', 'reference/api/server',
  'reference/api/netcode', 'reference/api/browser', 'reference/operations', 'reference/adopting', 'reference/changelog'];

const server = spawn('npx', ['vitepress', 'preview', '--port', String(PORT), '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('preview did not start')), 30000);
  server.stdout.on('data', d => { if (String(d).includes(String(PORT))) { clearTimeout(t); resolve(); } });
});

const failures = [], notes = [];
const fail = m => { failures.push(m); console.log('FAIL', m); };
const ok = m => { notes.push(m); console.log('ok  ', m); };
const browser = await chromium.launch();
try {
  // ---- every page, both widths, both schemes
  for (const [vw, vh] of [[1280, 900], [390, 844]]) for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, colorScheme: scheme, deviceScaleFactor: 1 });
    for (const path of PAGES) {
      const page = await ctx.newPage(), errors = [];
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', e => errors.push(String(e)));
      const res = await page.goto(BASE + path, { waitUntil: 'networkidle' });
      if (!res || res.status() !== 200) fail(`${path} ${vw} ${scheme}: HTTP ${res?.status()}`);
      await page.waitForTimeout(path.startsWith('how/') || path === '' ? 2500 : 300);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (wide > 1) fail(`${path || 'home'} ${vw} ${scheme}: scrolls sideways by ${wide}px`);
      if (errors.length) fail(`${path || 'home'} ${vw} ${scheme}: ${errors.length} console errors: ${errors.slice(0, 3).join(' | ')}`);
      const name = `${(path || 'home').replace(/\/$/, '').replace(/\//g, '_')}_${vw}_${scheme}`;
      if (path === '' || path.startsWith('how/') || scheme === 'light') await page.screenshot({ path: `${SHOTS}${name}.png` });
      if (vw === 1280 && scheme === 'light') {
        const fonts = await page.evaluate(() => [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family));
        if (path === '' && !fonts.some(f => f.includes('Big Shoulders'))) fail('home: Big Shoulders Display did not load');
      }
      await page.close();
    }
    await ctx.close();
    ok(`all ${PAGES.length} pages at ${vw}px ${scheme}`);
  }

  // ---- the explainers: they animate, and they answer their controls
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const open = async path => {
    const page = await ctx.newPage(), errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    const demo = page.locator('figure.tw-demo').first();
    await demo.scrollIntoViewIfNeeded();
    page.errors = errors; page.demo = demo; return page;
  };
  const frame = page => page.locator('figure.tw-demo canvas').first().evaluate(c => c.toDataURL());
  const animates = async (page, label) => {
    const a = await frame(page); await page.waitForTimeout(500); const b = await frame(page);
    if (a === b) fail(`${label}: canvas did not change in 0.5 s`); else ok(`${label}: animates`);
  };
  const text = page => page.demo.innerText();
  const until = async (page, fn, ms, label) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn(await text(page))) { ok(label); return true; } await page.waitForTimeout(200); }
    fail(`${label} (timed out; demo says: ${(await text(page)).replace(/\s+/g, ' ').slice(0, 300)})`); return false;
  };
  // (the sticky nav would cover the top of a tall explainer)
  const shot = async (page, name) => { await page.addStyleTag({ content: '.VPNav, .VPLocalNav { visibility: hidden !important; }' }); await page.demo.screenshot({ path: `${SHOTS}demo_${name}.png` }); };
  const done = async (page, label) => { if (page.errors.length) fail(`${label}: errors ${page.errors.slice(0, 3).join(' | ')}`); await page.close(); };

  { // home hero
    const page = await open('');
    await animates(page, 'hero');
    await until(page, t => t.includes('States ride the datagrams'), 15000, 'hero: datagram path proven');
    await shot(page, 'hero_datagrams');
    await page.getByLabel('Block UDP').check();
    await until(page, t => t.includes('UDP blocked'), 3000, 'hero: Block UDP answers');
    await page.waitForTimeout(7000);
    await shot(page, 'hero_blocked');
    await done(page, 'hero');
  }
  { // two wires
    const page = await open('how/two-wires');
    await animates(page, 'two wires');
    await page.getByLabel('Slow motion').uncheck();
    await until(page, t => /States arrive by\s*datagrams/.test(t), 8000, 'two wires: states on the datagrams');
    await page.getByRole('button', { name: 'Send an event' }).click();
    await until(page, t => /Events delivered\s*[1-9]/.test(t), 5000, 'two wires: an event arrives');
    await page.getByLabel('Block UDP').check();
    await until(page, t => /States arrive by\s*WebSocket/.test(t), 4000, 'two wires: Block UDP falls back to the WebSocket');
    await page.locator('figure.tw-demo input[type=range]').nth(2).fill('0.1');
    await page.waitForTimeout(3000);
    await shot(page, 'two_wires_blocked_loss');
    await page.getByLabel('Block UDP').uncheck();
    await until(page, t => /States arrive by\s*datagrams/.test(t), 15000, 'two wires: back on the datagrams after the retry');
    await done(page, 'two wires');
  }
  { // sessions
    const page = await open('how/sessions');
    await until(page, t => /Client\s*online/.test(t), 8000, 'sessions: online');
    await animates(page, 'sessions');
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Drop the connection' }).click();
    await until(page, t => /Resumed\s*[1-9]/.test(t), 6000, 'sessions: a dropped connection resumes the session');
    await page.getByLabel('Phone offline').check();
    await page.waitForTimeout(3500);
    await shot(page, 'sessions_offline');
    await page.getByLabel('Phone offline').uncheck();
    await until(page, t => /Resumed\s*[2-9]/.test(t) && /acknowledged\s*0/.test(t), 12000, 'sessions: back online, queued events delivered');
    await page.locator('figure.tw-demo input[type=range]').first().fill('3');
    await page.getByLabel('Phone offline').check();
    await page.waitForTimeout(5500);
    await page.getByLabel('Phone offline').uncheck();
    await until(page, t => t.includes('Session lost'), 12000, 'sessions: offline longer than the seat is held loses the session');
    await shot(page, 'sessions_lost');
    await page.getByRole('button', { name: 'Start a new session' }).click();
    await until(page, t => /Client\s*online/.test(t) && !t.includes('Session lost'), 8000, 'sessions: a new session');
    await done(page, 'sessions');
  }
  { // interpolation
    const page = await open('how/interpolation');
    await animates(page, 'interpolation');
    await until(page, t => /Mode\s*interpolate/.test(t), 4000, 'interpolation: interpolating');
    await shot(page, 'interpolation');
    await page.getByLabel('Interpolate', { exact: true }).uncheck();
    await until(page, t => /Mode\s*latest/.test(t), 3000, 'interpolation: off draws the latest snapshot');
    await page.getByLabel('Interpolate', { exact: true }).check();
    await page.getByLabel('Adaptive playback delay').uncheck();
    await page.locator('figure.tw-demo input[type=range]').nth(2).fill('150');
    await until(page, t => /Mode\s*hold/.test(t), 8000, 'interpolation: a fixed delay under jitter holds');
    await done(page, 'interpolation');
  }
  { // prediction
    const page = await open('how/prediction');
    await animates(page, 'prediction');
    await page.getByLabel('Wind on the server').check();
    await until(page, t => /Corrections, last 10 s\s*[1-9]/.test(t), 15000, 'prediction: the wind causes corrections');
    await shot(page, 'prediction_wind');
    await page.getByLabel('Predict', { exact: true }).uncheck();
    await until(page, t => /Input to screen\s*\d+ ms/.test(t), 6000, 'prediction: without prediction, input waits for the server');
    const box = await page.locator('figure.tw-demo canvas').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 5 });
    await until(page, t => /Driving\s*you/.test(t), 2000, 'prediction: dragging steers');
    await page.mouse.up();
    await done(page, 'prediction');
  }
  { // deltas
    const page = await open('how/deltas');
    await animates(page, 'deltas');
    await page.waitForTimeout(4000);
    const t = await text(page);
    const m = /Browser matches server\s*(\d+) of (\d+)/.exec(t), share = /\((\d+)%\)/.exec(t);
    if (!m || m[1] !== m[2] || +m[2] < 20) fail(`deltas: browser should match every snapshot (${m?.[0]})`); else ok(`deltas: browser matches server, ${m[0]}`);
    if (!share || +share[1] >= 60) fail(`deltas: deltas should be much smaller than whole snapshots (${share?.[0]})`); else ok(`deltas: ${share[1]}% of a whole snapshot`);
    await shot(page, 'deltas');
    await page.getByLabel('Send deltas').uncheck();
    await until(page, s => /\((9\d|100)%\)/.test(s), 6000, 'deltas: off sends whole snapshots');
    await done(page, 'deltas');
  }
  { // interest
    const page = await open('how/interest');
    await animates(page, 'interest');
    const box = await page.locator('figure.tw-demo canvas').boundingBox();
    await page.mouse.move(box.x + 60, box.y + 60); await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 90, { steps: 4 });
    await until(page, t => /Driving\s*you/.test(t), 2000, 'interest: dragging moves the player');
    await page.mouse.up();
    const before = await text(page);
    await page.locator('figure.tw-demo input[type=range]').nth(1).fill('400');
    await page.waitForTimeout(300);
    const after = await text(page);
    const n = s => +(/In the snapshot\s*(\d+)/.exec(s)?.[1] ?? 0);
    if (n(after) <= n(before)) fail(`interest: a bigger radius should find more (${n(before)} -> ${n(after)})`); else ok(`interest: radius answers (${n(before)} -> ${n(after)})`);
    await shot(page, 'interest');
    await done(page, 'interest');
  }
  { // lobby
    const page = await open('how/lobby');
    await until(page, t => (t.match(/online/g) ?? []).length >= 4, 8000, 'lobby: four players online');
    await page.getByRole('button', { name: 'Play the walkthrough' }).click();
    await until(page, t => /starts in \d/.test(t) || /playing/.test(t), 20000, 'lobby: ready-up counts down');
    await until(page, t => (t.match(/build 1, (lobby|playing)/g) ?? []).length >= 2 && /build 2, lobby/.test(t), 4000, 'lobby: SOL (build 2) got a room of their own');
    await shot(page, 'lobby');
    await done(page, 'lobby');
  }
  // the explainers at phone width
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  for (const path of ['how/two-wires', 'how/sessions', 'how/prediction', 'how/lobby']) {
    const page = await phone.newPage(); await page.goto(BASE + path, { waitUntil: 'networkidle' });
    const d = page.locator('figure.tw-demo').first(); await d.scrollIntoViewIfNeeded(); await page.waitForTimeout(2500);
    await d.screenshot({ path: `${SHOTS}demo_${path.split('/')[1]}_390_dark.png` }); await page.close();
  }
  ok('phone-width explainer screenshots');
} finally {
  await browser.close(); server.kill();
}
console.log(`\n${failures.length ? 'FAILED' : 'PASSED'}: ${notes.length} checks passed, ${failures.length} failed. Screenshots in website/.screens/`);
process.exit(failures.length ? 1 : 0);
