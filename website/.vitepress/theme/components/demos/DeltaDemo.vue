<script setup lang="ts">
// Delta snapshots against acknowledged baselines: two real Endpoints (states sent with ack: true, acknowledgements
// coming back as state-ack frames), SnapshotHistory, diffEntities and applyEntityDelta.
import { onMounted, onBeforeUnmount, ref, reactive } from 'vue';
import TwSlider from '../TwSlider.vue';
import TwToggle from '../TwToggle.vue';

const canvas = ref<HTMLCanvasElement>();
const s = reactive({ count: 60, moving: 0.15, loss: 0.1, latency: 60, deltas: true });
const out = reactive({ full: 0, avg: 0, share: 0, baseline: 0, age: 0, checked: 0, mismatches: 0, lost: 0, path: 'WebSocket' });
let stop = () => {};

onMounted(async () => {
  const [{ SimNet, endpointPair }, { SnapshotHistory, diffEntities, applyEntityDelta }, { stage, label }] = await Promise.all([
    import('../../lib/netsim'), import('twinwire/browser'), import('../../lib/stage')]);
  type Entities = Record<string, Record<string, number>>;
  const net = new SimNet();
  const pair = endpointPair(net);
  const history = new SnapshotHistory<Entities>();
  pair.server.onStateAck = (_stream, seq) => history.acknowledge(seq);
  const sentWorlds = new Map<number, Entities>(), views = new Map<number, Entities>();
  const enc = new TextEncoder(), dec = new TextDecoder();
  let world: Entities = {}, nextId = 0, nextTick = 0, lastSeq = 0;
  const bars: { at: number; bytes: number; full: number; got: boolean; seq: number }[] = [];
  const clone = (e: Entities): Entities => JSON.parse(JSON.stringify(e));
  const spawn = () => { world['e' + nextId++] = { x: Math.round(Math.random() * 1000), y: Math.round(Math.random() * 1000), hp: 100 }; };
  let clientView: Entities = {};

  pair.client.onState = st => {
    const msg = JSON.parse(dec.decode(st.data)) as { b: number; d: Parameters<typeof applyEntityDelta>[1] };
    const base = msg.b ? views.get(msg.b) ?? null : null;
    if (msg.b && !base) return;                                   // never happens: the server only uses acknowledged bases
    const view = applyEntityDelta(base, msg.d);
    views.set(st.seq, view); clientView = view;
    for (const k of [...views.keys()]) if (views.size > 80 && k < st.seq - 70) views.delete(k);
    const truth = sentWorlds.get(st.seq);
    if (truth) { out.checked++; if (JSON.stringify(sort(truth)) !== JSON.stringify(sort(view))) out.mismatches++; }
    const bar = bars.find(b => b.seq === st.seq); if (bar) bar.got = true;
    if (st.seq > lastSeq + 1 && lastSeq) out.lost += st.seq - lastSeq - 1;
    lastSeq = Math.max(lastSeq, st.seq);
  };
  const sort = (e: Entities) => Object.keys(e).sort().map(k => [k, e[k]!.x, e[k]!.y, e[k]!.hp]);

  stop = stage(canvas.value!, w => w < 520 ? 360 : 330, f => {
    net.set({ latency: s.latency, jitter: s.latency / 6, loss: s.loss });
    net.advance(f.dt);
    while (Object.keys(world).length < s.count) spawn();
    for (const k of Object.keys(world)) if (Object.keys(world).length > s.count) delete world[k];
    // the server: 20 snapshots a second, each a delta against the newest one this player acknowledged
    while (nextTick <= net.now) {
      nextTick += 50;
      for (const [id, e] of Object.entries(world)) {
        if (Math.random() < s.moving) { e.x = Math.max(0, Math.min(1000, e.x + Math.round((Math.random() - 0.5) * 60))); e.y = Math.max(0, Math.min(1000, e.y + Math.round((Math.random() - 0.5) * 60))); }
        if (Math.random() < s.moving * 0.02) e.hp = Math.max(0, e.hp - 10);
        if (e.hp === 0) { delete world[id]; spawn(); }
      }
      const base = s.deltas ? history.baseline : null;
      const full = enc.encode(JSON.stringify({ b: 0, d: diffEntities(null, world) }));
      const payload = base ? enc.encode(JSON.stringify({ b: base.seq, d: diffEntities(base.value, world) })) : full;
      const seq = pair.server.sendState(0, payload, net.now, { ack: true, ttlMs: 100 });
      if (seq) { const copy = clone(world); history.record(seq, copy); sentWorlds.set(seq, copy); bars.push({ at: net.now, bytes: payload.length, full: full.length, got: false, seq }); }
      for (const k of [...sentWorlds.keys()]) if (k < seq - 100) sentWorlds.delete(k);
      out.full = full.length; out.baseline = base?.seq ?? 0; out.age = base ? seq - base.seq : 0;
    }
    pair.pump();
    while (bars.length && bars[0]!.at < net.now - 5000) bars.shift();
    const recent = bars.slice(-40);
    out.avg = recent.length ? Math.round(recent.reduce((t, b) => t + b.bytes, 0) / recent.length) : 0;
    out.share = out.full ? Math.round(out.avg / out.full * 100) : 0;
    out.path = pair.client.fastActive ? 'datagrams' : 'WebSocket';

    // draw: the server's world and the browser's view side by side, then bytes per snapshot
    const { g, c, w, h } = f, narrow = w < 520, top = 26, boxH = narrow ? 150 : 170, gap = 16;
    const boxW = Math.min(narrow ? (w - 24 - gap) / 2 : 230, (w - 24 - gap) / 2), bx = narrow ? 12 : (w - (boxW * 2 + gap)) / 2;
    const panel = (x: number, title: string, ents: Entities) => {
      label(g, title, x, top - 12, c.ink2, `600 12.5px ${c.body}`);
      g.strokeStyle = c.rule; g.lineWidth = 1; g.strokeRect(x, top, boxW, boxH);
      for (const e of Object.values(ents)) {
        g.fillStyle = c.ink; g.globalAlpha = 0.3 + 0.7 * e.hp / 100;   // fainter as it loses health
        g.beginPath(); g.arc(x + 4 + e.x / 1000 * (boxW - 8), top + 4 + e.y / 1000 * (boxH - 8), 2.6, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
    };
    panel(bx, 'The server’s world', world);
    panel(bx + boxW + gap, 'The browser’s view', clientView);
    const cy0 = top + boxH + 34, cy1 = h - 14, cx0 = 52, cx1 = w - 14, max = Math.max(200, ...bars.map(b => b.full)) * 1.1;
    label(g, 'Bytes in each snapshot, the last 5 seconds', cx0, cy0 - 12, c.ink3, `12px ${c.body}`);
    g.strokeStyle = c.rule; g.beginPath(); g.moveTo(cx0, cy1); g.lineTo(cx1, cy1); g.stroke();
    label(g, `${(max / 1024).toFixed(1)} KB`, cx0 - 6, cy0, c.ink3, `12px ${c.body}`, 'right'); label(g, '0', cx0 - 6, cy1, c.ink3, `12px ${c.body}`, 'right');
    const bw = Math.max(2, (cx1 - cx0) / 100 - 1);
    for (const b of bars) {
      const x = cx1 - (net.now - b.at) / 5000 * (cx1 - cx0), bh = b.bytes / max * (cy1 - cy0), fh = b.full / max * (cy1 - cy0);
      g.fillStyle = c.grid; g.fillRect(x, cy1 - fh, bw, fh);
      g.fillStyle = b.got ? c.ink : c.loss; g.fillRect(x, cy1 - bh, bw, Math.max(1, bh));
    }
  });
});
onBeforeUnmount(() => stop());
</script>

<template>
  <figure class="tw-demo" aria-label="Delta snapshots against acknowledged baselines">
    <div class="stage"><canvas ref="canvas" role="img" aria-label="The server's world and the browser's rebuilt view, and the size of each snapshot" /></div>
    <div class="legend">
      <span><i :style="{ background: 'var(--tw-ink)' }" />Bytes sent, arrived</span>
      <span><i :style="{ background: 'var(--tw-loss)' }" />Bytes sent, lost (or still on the way)</span>
      <span><i :style="{ background: 'var(--tw-grid)', border: '1px solid var(--tw-rule)' }" />What a whole snapshot would cost</span>
    </div>
    <div class="controls">
      <TwSlider v-model="s.count" label="Entities" :min="10" :max="150" />
      <TwSlider v-model="s.moving" label="Changing each tick" :min="0" :max="1" :step="0.05" percent />
      <TwSlider v-model="s.loss" label="Packet loss" :min="0" :max="0.4" :step="0.01" percent />
      <TwSlider v-model="s.latency" label="Latency, one way" :min="10" :max="200" unit=" ms" />
      <div class="tw-control"><TwToggle v-model="s.deltas" label="Send deltas" /></div>
    </div>
    <div class="readouts">
      <span>Whole snapshot <b>{{ out.full }} B</b></span>
      <span>Sent on average <b>{{ out.avg }} B</b> ({{ out.share }}%)</span>
      <span>Baseline <b>{{ out.baseline ? '#' + out.baseline : 'none' }}</b><template v-if="out.baseline">, {{ out.age }} snapshots old</template></span>
      <span>Lost <b>{{ out.lost }}</b></span>
      <span>Browser matches server <b :style="{ color: out.mismatches ? 'var(--tw-loss)' : 'var(--tw-ok)' }">{{ out.checked - out.mismatches }} of {{ out.checked }}</b></span>
      <span>States arrive by <b :class="out.path === 'datagrams' ? 'dg' : 'ws'">{{ out.path }}</b></span>
    </div>
  </figure>
</template>
