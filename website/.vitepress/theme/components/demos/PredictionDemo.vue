<script setup lang="ts">
// Client-side prediction and server reconciliation with Twinwire's real Predictor, InputInbox, encodeInputs,
// decodeInputs and defineSchema. The server's rules are the party example's.
import { onMounted, onBeforeUnmount, ref, reactive } from 'vue';
import TwSlider from '../TwSlider.vue';
import TwToggle from '../TwToggle.vue';

const canvas = ref<HTMLCanvasElement>();
const s = reactive({ latency: 100, loss: 0.05, redundancy: 4, predict: true, reconcile: true, wind: false, slow: false });
const out = reactive({ rtt: 0, delay: '', pending: 0, corrections: 0, biggest: 0, skipped: 0, driving: 'autopilot' });
let stop = () => {};

onMounted(async () => {
  const [{ Predictor, InputInbox, FixedStepper, encodeInputs, decodeInputs, defineSchema }, { stage, label, rrect }] =
    await Promise.all([import('twinwire/browser'), import('../../lib/stage')]);
  type S = { x: number; y: number }; type I = { dx: number; dy: number };
  const W = 600, H = 300, SPEED = 150, R = 10, HZ = 60, SNAP_HZ = 20;
  const zone = { x0: 250, x1: 350 };
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  // the same move() on both sides; the server also has a wind the browser can't know about
  const move = (p: S, i: I, dt: number): S => {
    const len = Math.hypot(i.dx, i.dy); if (!len) return { x: p.x, y: p.y };
    const k = Math.min(1, len) / len;
    return { x: clamp(p.x + i.dx * k * SPEED * dt, R, W - R), y: clamp(p.y + i.dy * k * SPEED * dt, R, H - R) };
  };
  const serverMove = (p: S, i: I, dt: number): S => {
    const q = move(p, i, dt);
    return s.wind && q.x > zone.x0 && q.x < zone.x1 ? { x: q.x, y: clamp(q.y + 150 * dt, R, H - R) } : q;
  };
  const codec = defineSchema({ dx: { type: 'i8', scale: 100 }, dy: { type: 'i8', scale: 100 } });

  let now = 0;
  const spawn = { x: 120, y: 150 };
  const predictor = new Predictor<S, I>(spawn, move, 1 / HZ);
  let naive: S = { ...spawn }, lastSnap: S = { ...spawn }, lastTick = -1;
  const server = { state: { ...spawn }, last: { dx: 0, dy: 0 } as I, inbox: new InputInbox<I>(), newest: 0, tick: 0 };
  const toServer: { at: number; data: Uint8Array }[] = [], toClient: { at: number; tick: number; ack: number; state: S }[] = [];
  const clientStep = new FixedStepper(HZ), serverStep = new FixedStepper(HZ);
  const flashes: { from: S; to: S; at: number }[] = [];
  const corrections: { at: number; d: number }[] = [];
  const delays: number[] = [];
  const pressedAt = new Map<number, number>();   // input seq -> time, for input-to-screen delay without prediction

  // input: drag on the arena like a thumbstick, or keys; autopilot otherwise
  const keys = new Set<string>(); let drag: { x0: number; y0: number; x: number; y: number } | null = null;
  const el = canvas.value!;
  el.addEventListener('keydown', e => { const k = e.key.toLowerCase(); if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'].includes(k)) { keys.add(k); e.preventDefault(); } });
  el.addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
  el.addEventListener('blur', () => keys.clear());
  el.addEventListener('pointerdown', e => { el.setPointerCapture(e.pointerId); drag = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY }; el.focus(); });
  el.addEventListener('pointermove', e => { if (drag) { drag.x = e.clientX; drag.y = e.clientY; } });
  for (const ev of ['pointerup', 'pointercancel']) el.addEventListener(ev, () => { drag = null; });
  const input = (): I => {
    if (drag) { const dx = drag.x - drag.x0, dy = drag.y - drag.y0, l = Math.hypot(dx, dy); out.driving = 'you'; return l < 6 ? { dx: 0, dy: 0 } : { dx: dx / Math.max(l, 40), dy: dy / Math.max(l, 40) }; }
    if (keys.size) {
      out.driving = 'you';
      const k = (a: string, b: string) => keys.has(a) || keys.has(b) ? 1 : 0;
      return { dx: k('arrowright', 'd') - k('arrowleft', 'a'), dy: k('arrowdown', 's') - k('arrowup', 'w') };
    }
    // the autopilot steers toward a point running a figure-eight through the middle (and the wind band)
    out.driving = 'autopilot';
    const me = !s.predict ? lastSnap : s.reconcile ? predictor.state : naive;
    const tx = W / 2 + W * 0.36 * Math.sin(now * 0.0008), ty = H / 2 + H * 0.3 * Math.sin(now * 0.0016);
    const dx = tx - me.x, dy = ty - me.y, d = Math.hypot(dx, dy);
    return d < 4 ? { dx: 0, dy: 0 } : { dx: dx / Math.max(d, 30), dy: dy / Math.max(d, 30) };
  };

  stop = stage(el, w => w < 520 ? 300 : 340, f => {
    const dt = Math.min(100, f.dt) * (s.slow ? 0.25 : 1);
    now += dt;
    // the browser: one input per step, predicted at once, sent with the last few for redundancy
    clientStep.advance(dt, () => {
      const v = input(), q = { dx: Math.round(v.dx * 100) / 100, dy: Math.round(v.dy * 100) / 100 };
      const frame = predictor.push(q);
      naive = move(naive, q, 1 / HZ);
      if (!s.predict) pressedAt.set(frame.seq, now);
      const bundle = encodeInputs(predictor.recent(s.redundancy).map(i => ({ seq: i.seq, data: codec.encode(i.value) })));
      if (Math.random() >= s.loss) toServer.push({ at: now + s.latency * (0.9 + Math.random() * 0.2), data: bundle });
    });
    // the server: inputs arrive in bundles, each is taken once and in order; it steps at 60 Hz and snapshots at 20
    toServer.sort((a, b) => a.at - b.at);
    while (toServer.length && toServer[0]!.at <= now) {
      for (const i of decodeInputs(toServer.shift()!.data) ?? []) {
        const v = codec.decode(i.data); if (!v) continue;
        server.inbox.add({ seq: i.seq, value: v }); server.newest = Math.max(server.newest, i.seq);
      }
    }
    serverStep.advance(dt, () => {
      server.tick++;
      if (server.newest - server.inbox.applied > 10) { out.skipped += server.newest - 3 - server.inbox.applied; server.inbox.skipThrough(server.newest - 3); }
      const i = server.inbox.next(); if (i) server.last = i.value;
      server.state = serverMove(server.state, server.last, 1 / HZ);
      if (server.tick % (HZ / SNAP_HZ) === 0 && Math.random() >= s.loss)
        toClient.push({ at: now + s.latency * (0.9 + Math.random() * 0.2), tick: server.tick, ack: server.inbox.applied, state: { ...server.state } });
    });
    // the browser hears back: replay what the server hasn't applied yet on top of its word
    toClient.sort((a, b) => a.at - b.at);
    while (toClient.length && toClient[0]!.at <= now) {
      const snap = toClient.shift()!; if (snap.tick <= lastTick) continue;
      lastTick = snap.tick; lastSnap = snap.state; naive = { ...snap.state };
      const before = { ...predictor.state };
      predictor.reconcile({ ack: snap.ack, tick: snap.tick, state: snap.state });
      const d = Math.hypot(predictor.state.x - before.x, predictor.state.y - before.y);
      if (d > 0.75 && s.predict && s.reconcile) { corrections.push({ at: now, d }); flashes.push({ from: before, to: { ...predictor.state }, at: now }); }
      if (!s.predict) for (const [seq, at] of pressedAt) if (seq <= snap.ack) { delays.push(now - at); pressedAt.delete(seq); }
    }
    while (corrections.length && corrections[0]!.at < now - 10000) corrections.shift();
    while (delays.length > 30) delays.shift();
    if (s.predict) pressedAt.clear();

    const shown = !s.predict ? lastSnap : s.reconcile ? predictor.state : naive;
    out.rtt = Math.round(2 * s.latency);
    out.delay = s.predict ? 'none: predicted' : delays.length ? `${Math.round(delays.reduce((a, b) => a + b, 0) / delays.length)} ms` : 'measuring';
    out.pending = predictor.pendingCount;
    out.corrections = corrections.length; out.biggest = Math.round(Math.max(0, ...corrections.map(c => c.d)));

    // draw
    const { g, c, w, h } = f, sc = Math.min((w - 24) / W, (h - 24) / H), ox = (w - W * sc) / 2, oy = 12;
    const X = (p: S) => ox + p.x * sc, Y = (p: S) => oy + p.y * sc;
    rrect(g, ox, oy, W * sc, H * sc, 8); g.strokeStyle = c.rule; g.lineWidth = 1; g.stroke();
    if (s.wind) {
      g.fillStyle = c.dgSoft; g.fillRect(ox + zone.x0 * sc, oy, (zone.x1 - zone.x0) * sc, H * sc);
      g.strokeStyle = c.dg; g.lineWidth = 1.5;
      for (let y = 30; y < H; y += 60) { const x = ox + (zone.x0 + zone.x1) / 2 * sc, yy = oy + ((y + now * 0.05) % H) * sc; g.beginPath(); g.moveTo(x, yy - 8); g.lineTo(x, yy + 8); g.moveTo(x - 5, yy + 3); g.lineTo(x, yy + 8); g.lineTo(x + 5, yy + 3); g.stroke(); }
      label(g, 'wind (the server only)', ox + (zone.x0 + zone.x1) / 2 * sc, oy + H * sc - 12, c.dg, `600 12px ${c.body}`, 'center');
    }
    for (const fl of flashes) {
      const a = 1 - (now - fl.at) / 500; if (a <= 0) continue;
      g.globalAlpha = a; g.strokeStyle = c.loss; g.lineWidth = 2; g.beginPath(); g.moveTo(X(fl.from), Y(fl.from)); g.lineTo(X(fl.to), Y(fl.to)); g.stroke();
      g.beginPath(); g.arc(X(fl.from), Y(fl.from), R * sc, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1;
    }
    while (flashes.length && now - flashes[0]!.at > 500) flashes.shift();
    g.setLineDash([4, 4]); g.strokeStyle = c.ink3; g.lineWidth = 1.5; g.beginPath(); g.arc(X(server.state), Y(server.state), R * sc + 3, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
    g.strokeStyle = c.ink2; g.lineWidth = 1.5; g.beginPath(); g.arc(X(lastSnap), Y(lastSnap), R * sc - 2, 0, Math.PI * 2); g.stroke();
    g.fillStyle = c.ink; g.beginPath(); g.arc(X(shown), Y(shown), R * sc, 0, Math.PI * 2); g.fill();
    if (document.activeElement === el) { g.strokeStyle = c.ws; g.lineWidth = 2; rrect(g, ox + 1, oy + 1, W * sc - 2, H * sc - 2, 8); g.stroke(); }
  });
});
onBeforeUnmount(() => stop());
</script>

<template>
  <figure class="tw-demo" aria-label="Client-side prediction and server reconciliation">
    <div class="stage"><canvas ref="canvas" tabindex="0" role="img" aria-label="Your player as the browser draws it, the last snapshot from the server, and where the server has it now. Drag, or focus and use the arrow keys, to drive." /></div>
    <div class="legend">
      <span><i class="dot" :style="{ background: 'var(--tw-ink)' }" />You, as your browser draws you</span>
      <span><i class="ring" :style="{ color: 'var(--tw-ink-2)' }" />The last snapshot</span>
      <span><i class="ring" :style="{ color: 'var(--tw-ink-3)' }" />The server, now</span>
      <span :style="{ color: 'var(--tw-loss)' }"><i class="ring" />A correction</span>
    </div>
    <div class="controls">
      <TwSlider v-model="s.latency" label="Latency, one way" :min="0" :max="250" unit=" ms" />
      <TwSlider v-model="s.loss" label="Packet loss" :min="0" :max="0.3" :step="0.01" percent />
      <TwSlider v-model="s.redundancy" label="Inputs per packet" :min="1" :max="8" />
      <div class="tw-control"><TwToggle v-model="s.predict" label="Predict" /><TwToggle v-model="s.reconcile" label="Reconcile" /></div>
      <div class="tw-control"><TwToggle v-model="s.wind" label="Wind on the server" /><TwToggle v-model="s.slow" label="Slow motion (4×)" /></div>
    </div>
    <div class="readouts">
      <span>Driving <b>{{ out.driving }}</b></span>
      <span>Round trip <b>{{ out.rtt }} ms</b></span>
      <span>Input to screen <b>{{ out.delay }}</b></span>
      <span>Inputs the server hasn't confirmed <b>{{ out.pending }}</b></span>
      <span>Corrections, last 10 s <b>{{ out.corrections }}</b> (largest <b>{{ out.biggest }} px</b>)</span>
      <span>Inputs lost for good <b>{{ out.skipped }}</b></span>
    </div>
    <p class="caption">Drag on the arena to steer, or click it and use the arrow keys or WASD. Let go and the autopilot takes over.</p>
  </figure>
</template>
