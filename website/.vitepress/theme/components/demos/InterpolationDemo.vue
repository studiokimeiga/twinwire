<script setup lang="ts">
// Snapshot interpolation with Twinwire's real Timeline and AdaptivePlayback.
import { onMounted, onBeforeUnmount, ref, reactive } from 'vue';
import TwSlider from '../TwSlider.vue';
import TwToggle from '../TwToggle.vue';

const canvas = ref<HTMLCanvasElement>();
const s = reactive({ hz: 20, latency: 80, jitter: 40, loss: 0.05, interpolate: true, extrapolate: false, adaptive: true, slow: false });
const out = reactive({ delay: 0, mode: 'hold', behind: 0, error: 0 });
let stop = () => {};

onMounted(async () => {
  const [{ Timeline, AdaptivePlayback, lerp }, { stage, label }] = await Promise.all([import('twinwire/browser'), import('../../lib/stage')]);
  type P = { x: number; y: number };
  let now = 0;
  const truth = (t: number): P => ({ x: 0.5 + 0.38 * Math.sin(t * 0.0012), y: 0.5 + 0.34 * Math.sin(t * 0.0024 + 0.6) });
  let timeline = new Timeline<P>(64), playback = new AdaptivePlayback(1000 / s.hz, 1000 / s.hz, 400), hz = s.hz;
  const inFlight: { time: number; seq: number; at: number; value: P }[] = [];
  const sent: { time: number; lost: boolean; arrived: boolean }[] = [];
  const arrived: { time: number; value: P }[] = [];
  let seq = 0, nextSnap = 0, latest: { time: number; value: P } | null = null;
  const lerpP = (a: P, b: P, u: number): P => ({ x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u) });
  const extrapolate = (last: P, prev: P, ahead: number, interval: number): P => ({ x: last.x + (last.x - prev.x) * ahead / interval, y: last.y + (last.y - prev.y) * ahead / interval });

  stop = stage(canvas.value!, w => w < 520 ? 330 : 360, f => {
    const { g, c, w, h } = f, dt = Math.min(100, f.dt) * (s.slow ? 0.25 : 1);
    now += dt;
    if (s.hz !== hz) { hz = s.hz; playback = new AdaptivePlayback(1000 / hz, 1000 / hz, 400); }
    // the server: a snapshot every 1/hz seconds, across a network with latency, jitter and loss
    while (nextSnap <= now) {
      const lost = Math.random() < s.loss, rec = { time: nextSnap, lost, arrived: false };
      sent.push(rec);
      if (!lost) inFlight.push({ time: nextSnap, seq: ++seq, at: nextSnap + s.latency + Math.random() * s.jitter, value: truth(nextSnap) });
      nextSnap += 1000 / hz;
    }
    inFlight.sort((a, b) => a.at - b.at);
    while (inFlight.length && inFlight[0]!.at <= now) {
      const p = inFlight.shift()!;
      playback.observe(now, p.time);                         // how late was it? (arrival vs sample time, on the server clock)
      timeline.insert({ time: p.time, seq: p.seq, value: p.value });
      arrived.push({ time: p.time, value: p.value });
      if (!latest || p.time > latest.time) latest = { time: p.time, value: p.value };
      const r = sent.find(q => q.time === p.time); if (r) r.arrived = true;
    }
    while (sent.length && sent[0]!.time < now - 1500) sent.shift();
    // the browser: play back at a time that covers the jitter it actually sees
    const renderTime = s.adaptive ? playback.advance(now, dt) : now - 1000 / hz;
    let shown: P | null = null, mode = 'hold';
    if (!s.interpolate) { shown = latest?.value ?? null; mode = 'latest'; }
    else {
      const r = timeline.sample(renderTime, lerpP, s.extrapolate ? extrapolate : undefined, 250);
      if (r) { shown = r.value; mode = r.mode; }
    }
    out.delay = Math.round(s.adaptive ? playback.delayMs : 1000 / hz); out.mode = mode;
    out.behind = Math.round(now - (s.interpolate ? renderTime : latest?.time ?? now));

    // the arena
    const ah = h - 92, size = Math.min(w - 24, ah * 1.6), ax = (w - size) / 2, ay = 12, aw = size, AH = ah - 12;
    const X = (p: P) => ax + p.x * aw, Y = (p: P) => ay + p.y * AH;
    g.strokeStyle = c.grid; g.lineWidth = 1;
    g.beginPath(); for (let t = now - 5300; t <= now; t += 40) { const p = truth(t); if (t === now - 5300) g.moveTo(X(p), Y(p)); else g.lineTo(X(p), Y(p)); } g.stroke();
    while (arrived.length && arrived[0]!.time < now - 1500) arrived.shift();
    for (const p of arrived) {
      g.globalAlpha = 0.35 + 0.65 * (1 - (now - p.time) / 1500); g.strokeStyle = c.ink2; g.lineWidth = 1.5;
      g.beginPath(); g.arc(X(p.value), Y(p.value), 4, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1;
    }
    const tp = truth(now);
    g.setLineDash([4, 4]); g.strokeStyle = c.ink3; g.lineWidth = 1.5; g.beginPath(); g.arc(X(tp), Y(tp), 11, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
    label(g, 'the server, now', X(tp) + 16, Y(tp), c.ink3, `600 12px ${c.body}`);
    if (shown) {
      out.error = Math.round(Math.hypot((shown.x - tp.x) * aw, (shown.y - tp.y) * AH));
      g.fillStyle = c.ink; g.beginPath(); g.arc(X(shown), Y(shown), 9, 0, Math.PI * 2); g.fill();
      if (mode === 'extrapolate' || mode === 'hold') { g.strokeStyle = mode === 'hold' ? c.loss : c.dgFill; g.lineWidth = 3; g.beginPath(); g.arc(X(shown), Y(shown), 13, 0, Math.PI * 2); g.stroke(); }
      label(g, 'what you see', X(shown) - 16, Y(shown), c.ink, `700 12.5px ${c.body}`, 'right');
    }
    // the buffer: snapshots by their time, the moment being drawn, and now
    const by = h - 52, bx0 = 16, bx1 = w - 16, win = 700, BX = (t: number) => bx1 - (now - t) / win * (bx1 - bx0);
    g.strokeStyle = c.rule; g.lineWidth = 1; g.beginPath(); g.moveTo(bx0, by); g.lineTo(bx1, by); g.stroke();
    label(g, 'Snapshots by the time they describe (filled: arrived, hollow: on the way, red: lost)', bx0, by - 24, c.ink3, `12px ${c.body}`);
    for (const r of sent) {
      const x = BX(r.time); if (x < bx0) continue;
      g.lineWidth = 2;
      if (r.lost) { g.strokeStyle = c.loss; g.beginPath(); g.moveTo(x - 4, by - 4); g.lineTo(x + 4, by + 4); g.moveTo(x + 4, by - 4); g.lineTo(x - 4, by + 4); g.stroke(); }
      else if (r.arrived) { g.fillStyle = c.ink2; g.fillRect(x - 2, by - 8, 4, 16); }
      else { g.strokeStyle = c.ink3; g.strokeRect(x - 2, by - 8, 4, 16); }
    }
    if (s.interpolate) {
      const x = BX(renderTime); g.strokeStyle = c.ws; g.lineWidth = 2; g.beginPath(); g.moveTo(x, by - 14); g.lineTo(x, by + 14); g.stroke();
      label(g, `drawn: ${out.delay} ms ago`, x, by + 24, c.ws, `700 12px ${c.body}`, x > bx1 - 90 ? 'right' : 'center');
    }
    label(g, 'now', bx1, by - 14, c.ink3, `12px ${c.body}`, 'right');
  });
});
onBeforeUnmount(() => stop());
</script>

<template>
  <figure class="tw-demo" aria-label="Snapshot interpolation">
    <div class="stage"><canvas ref="canvas" role="img" aria-label="A moving object as the server has it, the snapshots that arrived, and where the browser draws it" /></div>
    <div class="legend">
      <span><i class="dot" :style="{ background: 'var(--tw-ink)' }" />What the player sees</span>
      <span><i class="ring" :style="{ color: 'var(--tw-ink-2)' }" />A snapshot that arrived</span>
      <span><i class="ring" :style="{ color: 'var(--tw-ink-3)' }" />Where the server has it now</span>
      <span :style="{ color: 'var(--tw-dg)' }"><i class="ring" />Extrapolating</span>
      <span :style="{ color: 'var(--tw-loss)' }"><i class="ring" />Holding (nothing newer)</span>
    </div>
    <div class="controls">
      <TwSlider v-model="s.hz" label="Snapshots per second" :min="5" :max="60" />
      <TwSlider v-model="s.latency" label="Latency, one way" :min="10" :max="250" unit=" ms" />
      <TwSlider v-model="s.jitter" label="Jitter" :min="0" :max="150" unit=" ms" />
      <TwSlider v-model="s.loss" label="Packet loss" :min="0" :max="0.3" :step="0.01" percent />
      <div class="tw-control"><TwToggle v-model="s.interpolate" label="Interpolate" /><TwToggle v-model="s.extrapolate" label="Extrapolate past the newest" /></div>
      <div class="tw-control"><TwToggle v-model="s.adaptive" label="Adaptive playback delay" /><TwToggle v-model="s.slow" label="Slow motion (4×)" /></div>
    </div>
    <div class="readouts">
      <span>Playback delay <b>{{ out.delay }} ms</b></span>
      <span>Mode <b>{{ out.mode }}</b></span>
      <span>Drawn <b>{{ out.behind }} ms</b> behind the server</span>
      <span>Behind where the server has it now by <b>{{ out.error }} px</b></span>
    </div>
  </figure>
</template>
