<script setup lang="ts">
// Two real Twinwire Endpoints (the browser's and the server's) over a simulated WebSocket and datagram path.
import { onMounted, onBeforeUnmount, ref, reactive, watch } from 'vue';
import TwSlider from '../TwSlider.vue';
import TwToggle from '../TwToggle.vue';

const props = defineProps<{ variant?: 'hero' | 'full' }>();
const hero = props.variant === 'hero';
const canvas = ref<HTMLCanvasElement>();
const s = reactive({ latency: hero ? 70 : 60, jitter: hero ? 15 : 10, loss: hero ? 0.03 : 0.03, blocked: false, slow: true });
const out = reactive({ path: 'connecting', rtt: 0, stateAge: 0, events: 0, eventsFast: 0, blockedFor: -1, wsWorst: 0, dgWorst: 0 });
let stop = () => {}, sendEvent = () => {};

onMounted(async () => {
  const [{ SimNet, endpointPair }, { stage }, { layout, drawWires }] = await Promise.all([
    import('../../lib/netsim'), import('../../lib/stage'), import('../../lib/wires')]);
  const net = new SimNet();
  const apply = () => { net.set({ latency: s.latency, jitter: s.jitter, loss: s.loss }); net.params.dg.blocked = s.blocked; net.speed = s.slow ? (hero ? 0.3 : 0.2) : 1; };
  apply(); watch(s, apply);
  let blockedAt = -1;
  watch(() => s.blocked, b => { blockedAt = b ? net.now : -1; });
  const pair = endpointPair(net);
  const arrivals: { at: number; delay: number; via: 'ws' | 'dg'; event: boolean }[] = [];
  pair.client.onState = st => arrivals.push({ at: net.now, delay: net.now - st.time, via: st.via === 'rtc' ? 'dg' : 'ws', event: false });
  pair.client.onEvent = d => {
    const sent = (d as { at: number }).at;
    out.events++; if (pair.via === 'dg') out.eventsFast++;
    arrivals.push({ at: net.now, delay: net.now - sent, via: pair.via, event: true });
  };
  let n = 0;
  sendEvent = () => { pair.server.sendEvent({ t: 'hit', n: ++n, at: net.now }); };
  let nextSnap = 0, nextInput = 0, nextEvent = 800;
  const bytes = (k: number) => new Uint8Array(k);
  const chartH = hero ? 0 : 128;
  stop = stage(canvas.value!, w => hero ? (w < 520 ? 190 : 210) : (w < 520 ? 230 : 270) + chartH, f => {
    net.advance(f.dt);
    // traffic: snapshots 20 times a second, inputs 30, and now and then an event that must arrive
    while (nextSnap <= net.now) { pair.server.sendState(0, bytes(90), nextSnap, { ttlMs: 100 }); nextSnap += 50; }
    while (nextInput <= net.now) { pair.client.sendState(1, bytes(14), nextInput, { ttlMs: 50 }); nextInput += 33.3; }
    if (net.now >= nextEvent) { sendEvent(); nextEvent = net.now + (hero ? 1400 : 1800); }
    pair.pump();
    const wiresH = f.h - chartH;
    drawWires({ ...f, h: wiresH }, net, pair, layout(f.w, wiresH, hero));
    // readouts
    out.path = pair.client.fastActive ? 'datagrams' : 'WebSocket';
    out.rtt = Math.round(pair.client.stats.datagramRttMs);
    out.blockedFor = blockedAt < 0 ? -1 : (net.now - blockedAt) / 1000;
    while (arrivals.length && arrivals[0]!.at < net.now - 6000) arrivals.shift();
    const recent = arrivals.filter(a => !a.event && a.at > net.now - 1000);
    out.stateAge = recent.length ? Math.round(recent.reduce((t, a) => t + a.delay, 0) / recent.length) : 0;
    if (!hero) drawChart(f, wiresH, chartH);
  });
  function drawChart(f: import('../../lib/stage').Frame, top: number, h: number) {
    const { g, c, w } = f, x0 = 54, x1 = w - 16, y0 = top + 18, y1 = top + h - 22, span = 6000;
    const max = Math.max(200, ...arrivals.map(a => a.delay)) * 1.1;
    g.strokeStyle = c.rule; g.lineWidth = 1; g.beginPath(); g.moveTo(x0, y1); g.lineTo(x1, y1); g.moveTo(x0, y0); g.lineTo(x0, y1); g.stroke();
    g.fillStyle = c.ink3; g.font = `12px ${c.body}`; g.textAlign = 'right'; g.textBaseline = 'middle';
    g.fillText(`${Math.round(max)} ms`, x0 - 6, y0); g.fillText('0', x0 - 6, y1);
    g.textAlign = 'left'; g.fillText('How long each state and event took to arrive, the last 6 seconds', x0 + 4, top + 6);
    for (const a of arrivals) {
      const x = x1 - (net.now - a.at) / span * (x1 - x0), y = y1 - Math.min(1, a.delay / max) * (y1 - y0);
      g.fillStyle = a.via === 'dg' ? c.dgFill : c.ws;
      if (a.event) { g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x + 5, y); g.lineTo(x, y + 5); g.lineTo(x - 5, y); g.closePath(); g.fill(); }
      else { g.beginPath(); g.arc(x, y, 2.3, 0, Math.PI * 2); g.fill(); }
    }
  }
});
onBeforeUnmount(() => stop());
</script>

<template>
  <figure :class="['tw-demo', hero ? 'tw-hero-demo' : '']" aria-label="Two endpoints exchanging packets over a WebSocket and a datagram path">
    <div class="stage"><canvas ref="canvas" role="img" aria-label="Packets crossing the WebSocket (top) and the datagram path (bottom) between a browser and a server" /></div>
    <div v-if="hero" class="hero-bar">
      <TwToggle v-model="s.blocked" label="Block UDP" />
      <span class="hero-status" aria-live="polite">
        <template v-if="s.blocked && out.path === 'datagrams'">UDP blocked {{ out.blockedFor.toFixed(1) }} s ago. Probe replies have stopped; after 1.5 s without one, states move to the <span class="ws">WebSocket</span>.</template>
        <template v-else-if="s.blocked">UDP blocked {{ out.blockedFor.toFixed(1) }} s ago. Everything rides the <span class="ws">WebSocket</span>; the session never noticed.</template>
        <template v-else-if="out.path === 'datagrams'">States ride the <span class="dg">datagrams</span>. Events go on the <span class="ws">WebSocket</span> and race a copy on the datagrams.</template>
        <template v-else>States ride the <span class="ws">WebSocket</span> until the datagram path proves itself both ways.</template>
      </span>
    </div>
    <template v-else>
      <div class="legend">
        <span><i :style="{ background: 'var(--tw-ws)' }" />WebSocket</span>
        <span><i :style="{ background: 'var(--tw-dg-fill)' }" />Datagrams</span>
        <span>Bar: state</span><span>Diamond: event</span><span>Ring: probe</span><span>Square: acknowledgement</span>
        <span :style="{ color: 'var(--tw-loss)' }">Cross: lost</span>
      </div>
      <div class="controls">
        <TwSlider v-model="s.latency" label="Latency, one way" :min="5" :max="250" unit=" ms" />
        <TwSlider v-model="s.jitter" label="Jitter" :min="0" :max="80" unit=" ms" />
        <TwSlider v-model="s.loss" label="Packet loss" :min="0" :max="0.3" :step="0.01" percent />
        <div class="tw-control"><TwToggle v-model="s.blocked" label="Block UDP" /><TwToggle v-model="s.slow" label="Slow motion (5×)" /></div>
      </div>
      <div class="actions"><button class="tw-btn" type="button" @click="sendEvent()">Send an event</button></div>
      <div class="readouts" aria-live="off">
        <span>States arrive by <b :class="out.path === 'datagrams' ? 'dg' : 'ws'">{{ out.path }}</b></span>
        <span>Average state age <b>{{ out.stateAge }} ms</b></span>
        <span>Datagram round trip <b>{{ out.rtt ? out.rtt + ' ms' : 'none yet' }}</b></span>
        <span>Events delivered <b>{{ out.events }}</b>, first by datagram <b>{{ out.eventsFast }}</b></span>
      </div>
    </template>
  </figure>
</template>

<style scoped>
.hero-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 22px; padding: 12px 18px; border-top: 1px solid var(--tw-rule); background: var(--tw-paper-2); }
.hero-status { font-size: 14.5px; color: var(--tw-ink-2); flex: 1 1 280px; line-height: 1.45; }
.tw-hero-demo { margin: 0; }
</style>
