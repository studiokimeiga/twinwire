<script setup lang="ts">
// Interest management with Twinwire's real SpatialGrid: only what is near a player goes into their snapshot.
import { onMounted, onBeforeUnmount, ref, reactive } from 'vue';
import TwSlider from '../TwSlider.vue';

const canvas = ref<HTMLCanvasElement>();
const s = reactive({ count: 400, radius: 170, cell: 80 });
const out = reactive({ cells: 0, checked: 0, found: 0, bytes: 0, all: 0, driving: 'autopilot' });
let stop = () => {};

onMounted(async () => {
  const [{ SpatialGrid }, { stage, label }] = await Promise.all([import('twinwire/browser'), import('../../lib/stage')]);
  const W = 1200, H = 700, BYTES = 9;   // an entity in a snapshot: an id, a position, an angle and a state
  type E = { x: number; y: number; vx: number; vy: number };
  const ents: E[] = [];
  let grid = new SpatialGrid<number>(s.cell), cell = s.cell;
  const viewer = { x: W / 2, y: H / 2 };
  let drag = false, t = 0;
  const el = canvas.value!;
  let toWorld = (cx: number, cy: number) => ({ x: cx, y: cy });
  el.addEventListener('pointerdown', e => { drag = true; el.setPointerCapture(e.pointerId); Object.assign(viewer, toWorld(e.offsetX, e.offsetY)); });
  el.addEventListener('pointermove', e => { if (drag) Object.assign(viewer, toWorld(e.offsetX, e.offsetY)); });
  for (const ev of ['pointerup', 'pointercancel']) el.addEventListener(ev, () => { drag = false; });

  stop = stage(el, w => Math.round(Math.min(460, Math.max(260, w * 0.58))), f => {
    const { g, c, w, h, dt } = f;
    t += dt;
    if (s.cell !== cell) { cell = s.cell; grid = new SpatialGrid<number>(cell); }
    while (ents.length < s.count) { const a = Math.random() * Math.PI * 2, v = 20 + Math.random() * 40; ents.push({ x: Math.random() * W, y: Math.random() * H, vx: Math.cos(a) * v, vy: Math.sin(a) * v }); }
    while (ents.length > s.count) { ents.pop(); grid.remove(ents.length); }
    if (!drag) { viewer.x = W / 2 + Math.cos(t * 0.00035) * W * 0.3; viewer.y = H / 2 + Math.sin(t * 0.0007) * H * 0.28; }
    out.driving = drag ? 'you' : 'autopilot';
    ents.forEach((e, id) => {
      e.x += e.vx * dt / 1000; e.y += e.vy * dt / 1000;
      if (e.x < 0 || e.x > W) { e.vx *= -1; e.x = Math.max(0, Math.min(W, e.x)); }
      if (e.y < 0 || e.y > H) { e.vy *= -1; e.y = Math.max(0, Math.min(H, e.y)); }
      grid.upsert(id, e);
    });
    const found = grid.query(viewer, s.radius);
    // which cells a query looks in: every cell the circle's square touches
    const minX = Math.floor((viewer.x - s.radius) / cell), maxX = Math.floor((viewer.x + s.radius) / cell);
    const minY = Math.floor((viewer.y - s.radius) / cell), maxY = Math.floor((viewer.y + s.radius) / cell);
    let checked = 0;
    for (const e of ents) { const cx = Math.floor(e.x / cell), cy = Math.floor(e.y / cell); if (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY) checked++; }
    Object.assign(out, { cells: (maxX - minX + 1) * (maxY - minY + 1), checked, found: found.size, bytes: found.size * BYTES, all: ents.length * BYTES });

    const sc = Math.min((w - 16) / W, (h - 16) / H), ox = (w - W * sc) / 2, oy = (h - H * sc) / 2;
    toWorld = (cx, cy) => ({ x: Math.max(0, Math.min(W, (cx - ox) / sc)), y: Math.max(0, Math.min(H, (cy - oy) / sc)) });
    g.fillStyle = c.wsSoft;
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      const rx = ox + x * cell * sc, ry = oy + y * cell * sc;
      const x0 = Math.max(ox, rx), y0 = Math.max(oy, ry), x1 = Math.min(ox + W * sc, rx + cell * sc), y1 = Math.min(oy + H * sc, ry + cell * sc);
      if (x1 > x0 && y1 > y0) g.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
    g.strokeStyle = c.grid; g.lineWidth = 1; g.beginPath();
    for (let x = 0; x <= W; x += cell) { g.moveTo(ox + x * sc, oy); g.lineTo(ox + x * sc, oy + H * sc); }
    for (let y = 0; y <= H; y += cell) { g.moveTo(ox, oy + y * sc); g.lineTo(ox + W * sc, oy + y * sc); }
    g.stroke(); g.strokeStyle = c.rule; g.strokeRect(ox, oy, W * sc, H * sc);
    ents.forEach((e, id) => {
      const x = ox + e.x * sc, y = oy + e.y * sc;
      if (found.has(id)) { g.fillStyle = c.ink; g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }
      else { g.fillStyle = c.ink3; g.globalAlpha = 0.45; g.beginPath(); g.arc(x, y, 1.8, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; }
    });
    g.strokeStyle = c.ws; g.lineWidth = 2; g.beginPath(); g.arc(ox + viewer.x * sc, oy + viewer.y * sc, s.radius * sc, 0, Math.PI * 2); g.stroke();
    g.fillStyle = c.ws; g.beginPath(); g.arc(ox + viewer.x * sc, oy + viewer.y * sc, 6, 0, Math.PI * 2); g.fill();
    label(g, 'a player', ox + viewer.x * sc + 10, oy + viewer.y * sc - 10, c.ws, `700 12.5px ${c.body}`);
  });
});
onBeforeUnmount(() => stop());
</script>

<template>
  <figure class="tw-demo" aria-label="Interest management with a spatial grid">
    <div class="stage"><canvas ref="canvas" role="img" aria-label="A map of entities, a player's view radius, and the grid cells a query looks in. Drag to move the player." /></div>
    <div class="legend">
      <span><i class="dot" :style="{ background: 'var(--tw-ink)' }" />In this player's snapshot</span>
      <span><i class="dot" :style="{ background: 'var(--tw-ink-3)' }" />Left out</span>
      <span><i :style="{ background: 'var(--tw-ws-soft)', height: '10px', border: '1px solid var(--tw-ws)' }" />Cells the query looks in</span>
    </div>
    <div class="controls">
      <TwSlider v-model="s.count" label="Entities on the map" :min="50" :max="1500" :step="50" />
      <TwSlider v-model="s.radius" label="View radius" :min="40" :max="450" unit=" units" />
      <TwSlider v-model="s.cell" label="Cell size" :min="20" :max="300" :step="10" unit=" units" />
    </div>
    <div class="readouts">
      <span>Driving <b>{{ out.driving }}</b></span>
      <span>Cells looked in <b>{{ out.cells }}</b></span>
      <span>Entities checked <b>{{ out.checked }}</b> of {{ s.count }}</span>
      <span>In the snapshot <b>{{ out.found }}</b></span>
      <span>Snapshot <b>{{ out.bytes }} B</b> instead of {{ out.all }} B</span>
    </div>
    <p class="caption">Drag on the map to move the player. An entity costs 9 bytes here; the saving is the same in any format.</p>
  </figure>
</template>
