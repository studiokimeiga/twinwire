<script setup lang="ts">
// Twinwire's real GameServer and GameClient, joined by a simulated network you can break.
import { onMounted, onBeforeUnmount, ref, reactive, watch } from 'vue';
import TwSlider from '../TwSlider.vue';
import TwToggle from '../TwToggle.vue';

const canvas = ref<HTMLCanvasElement>();
const s = reactive({ latency: 60, grace: 10, offline: false, background: false });
const out = reactive({ status: 'idle', id: '', epoch: 0, attempts: 0, outbox: 0, lost: '', resumes: 0, held: -1 });
let stop = () => {};
const actions = { drop: () => {}, fresh: () => {} };

onMounted(async () => {
  const [{ LiveNet, LIVE_URL }, { GameClient }, { stage, label }] = await Promise.all([
    import('../../lib/livenet'), import('twinwire/browser'), import('../../lib/stage')]);
  const net = new LiveNet({ resumeGraceMs: s.grace * 1000 });
  await net.start();
  watch(() => s.latency, v => { net.latency = v; net.jitter = v / 5; }, { immediate: true });
  watch(() => s.grace, v => { (net.server.options as { resumeGraceMs?: number }).resumeGraceMs = v * 1000; });
  watch(() => s.offline, v => { net.offline = v; });

  // what happened, for the timeline
  type Span = { from: number; to: number | null; state: string };
  const conn: Span[] = [], seat: Span[] = [];
  const mark = (list: Span[], state: string) => { const now = performance.now(), last = list[list.length - 1]; if (last && last.state === state) return; if (last) last.to = now; list.push({ from: now, to: null, state }); };
  const attempts: { at: number; refused: boolean }[] = [];
  const sent = new Map<number, { at: number; got: number | null; dropped: boolean }>();
  net.onLog = e => { if (e.kind === 'attempt') { attempts.push({ at: e.t, refused: false }); out.attempts++; } if (e.kind === 'refused') { const a = attempts[attempts.length - 1]; if (a) a.refused = true; } };

  net.server.on('session', (session, resumed) => {
    mark(seat, 'connected'); if (resumed) out.resumes++;
    session.onEvent = d => { const r = sent.get((d as { n: number }).n); if (r && r.got === null) r.got = performance.now(); };
  });
  net.server.on('disconnect', () => mark(seat, 'held'));
  net.server.on('expire', () => mark(seat, 'expired'));

  let client = makeClient();
  function makeClient() {
    const c = new GameClient({ url: LIVE_URL, room: 'demo', rtc: false, websocket: net.websocket, auth: { name: 'WREN' } });
    c.onStatus = st => { out.status = st; mark(conn, st); };
    c.onSession = ({ id }) => { out.id = id.slice(0, 8); out.lost = ''; };
    c.onSessionLost = ({ reason, pendingEvents }) => {
      out.lost = `${reason}${pendingEvents ? `: ${pendingEvents} unsent event${pendingEvents > 1 ? 's' : ''} stay with the old session` : ''}`;
      for (const r of sent.values()) if (r.got === null) r.dropped = true;
    };
    c.connect(); return c;
  }
  actions.drop = () => client.simulateDrop();
  actions.fresh = () => { s.background = false; client.newSession(); };
  watch(() => s.background, v => { if (v) client.pause(); else client.resume(); });

  // the game sends an event every second: a step, a shot, a door
  let n = 0;
  const timer = setInterval(() => {
    if (client.status === 'lost' || client.status === 'closed' || client.status === 'paused' || client.status === 'idle') return;
    try { client.sendEvent({ t: 'step', n: ++n }); sent.set(n, { at: performance.now(), got: null, dropped: false }); } catch { /* outbox full */ }
  }, 1000);

  const WINDOW = 30000;
  const stopStage = stage(canvas.value!, w => w < 520 ? 250 : 236, f => {
    const { g, c, w, h } = f, now = performance.now(), x0 = w < 520 ? 12 : 128, x1 = w - 14;
    const X = (t: number) => x1 - (now - t) / WINDOW * (x1 - x0);
    const narrow = w < 520, rows = narrow ? { conn: 34, sent: 98, got: 140, seat: 204 } : { conn: 36, sent: 96, got: 138, seat: 196 };
    const lab = (text: string, y: number) => narrow ? label(g, text, x0, y - 17, c.ink3, `600 12px ${c.body}`) : label(g, text, x0 - 12, y, c.ink3, `600 12.5px ${c.body}`, 'right');
    // time grid: one line every 5 s
    g.strokeStyle = c.grid; g.lineWidth = 1;
    for (let t = Math.ceil((now - WINDOW) / 5000) * 5000; t <= now; t += 5000) { const x = X(t); g.beginPath(); g.moveTo(x, 14); g.lineTo(x, h - 8); g.stroke(); }
    // the browser's connection
    lab(narrow ? 'Browser: connection' : 'Connection', rows.conn);
    for (const sp of conn) {
      const a = Math.max(x0, X(sp.from)), b = X(sp.to ?? now); if (b < x0) continue;
      const col = sp.state === 'online' ? c.ws : sp.state === 'lost' ? c.loss : sp.state === 'paused' ? c.ink3 : c.rule;
      g.fillStyle = col; g.fillRect(a, rows.conn - (sp.state === 'online' ? 6 : 2), Math.max(1, b - a), sp.state === 'online' ? 12 : 4);
    }
    for (const at of attempts) { const x = X(at.at); if (x < x0) continue; g.fillStyle = at.refused ? c.loss : c.ink2; g.fillRect(x - 1, rows.conn + 10, 2, 8); }
    // events: sent by the browser, received by the server
    lab(narrow ? 'Events: sent (top), received by the server (bottom)' : 'Event sent', rows.sent);
    if (!narrow) lab('Event received', rows.got);
    for (const [k, r] of sent) {
      const xa = X(r.at); if (r.got !== null && X(r.got) < x0) { sent.delete(k); continue; }
      if (xa >= x0) { g.fillStyle = c.ws; g.beginPath(); g.arc(xa, rows.sent, 4, 0, Math.PI * 2); g.fill(); }
      const xb = r.got !== null ? X(r.got) : X(now);
      g.strokeStyle = r.dropped ? c.loss : r.got !== null ? c.ws : c.ink3; g.lineWidth = 1.5;
      if (r.got === null && !r.dropped) g.setLineDash([3, 4]);
      g.beginPath(); g.moveTo(Math.max(x0, xa), rows.sent + 4); g.lineTo(Math.max(x0, xb), r.got !== null ? rows.got - 4 : rows.sent + 14 + (rows.got - rows.sent - 18) * Math.min(1, (now - r.at) / 4000)); g.stroke(); g.setLineDash([]);
      if (r.got !== null) { g.fillStyle = c.ink; g.beginPath(); g.arc(xb, rows.got, 4, 0, Math.PI * 2); g.fill(); }
    }
    // the server's view of the seat
    lab(narrow ? 'Server: the session and its seat' : 'Server seat', rows.seat);
    for (const sp of seat) {
      const a = Math.max(x0, X(sp.from)), b = X(sp.to ?? now); if (b < x0) continue;
      if (sp.state === 'connected') { g.fillStyle = c.server; g.fillRect(a, rows.seat - 6, Math.max(1, b - a), 12); }
      else if (sp.state === 'held') { g.strokeStyle = c.server; g.lineWidth = 1.5; g.setLineDash([5, 4]); g.strokeRect(a, rows.seat - 6, Math.max(1, b - a), 12); g.setLineDash([]); }
      else { g.fillStyle = c.loss; g.fillRect(a, rows.seat - 2, Math.max(2, b - a), 4); }
    }
    while (conn.length > 2 && (conn[1]!.to ?? now) < now - WINDOW) conn.shift();
    while (seat.length > 2 && (seat[1]!.to ?? now) < now - WINDOW) seat.shift();
    while (attempts.length && attempts[0]!.at < now - WINDOW) attempts.shift();
    label(g, 'now', x1, h - 10, c.ink3, `12px ${c.body}`, 'right');
    // readouts
    out.outbox = client.endpoint.events.size;
    const session = [...net.server.sessions.values()][0];
    out.epoch = session?.epoch ?? 0;
    const lastSeat = seat[seat.length - 1];
    out.held = lastSeat?.state === 'held' ? Math.max(0, s.grace - (now - lastSeat.from) / 1000) : -1;
  });
  stop = () => { stopStage(); clearInterval(timer); client.close(); net.stop(); };
});
onBeforeUnmount(() => stop());
</script>

<template>
  <figure class="tw-demo" aria-label="A session that survives a dropped connection">
    <div class="stage"><canvas ref="canvas" role="img" aria-label="Timeline of the connection, the events sent and received, and the server's seat" /></div>
    <div class="legend">
      <span><i :style="{ background: 'var(--tw-ws)' }" />Online</span>
      <span><i :style="{ background: 'var(--tw-ink-2)', width: '3px', height: '9px' }" />Connection attempt</span>
      <span><i :style="{ background: 'var(--tw-loss)', width: '3px', height: '9px' }" />Attempt failed</span>
      <span><i :style="{ background: 'var(--tw-server)' }" />Seat in use</span>
      <span><i :style="{ background: 'transparent', border: '1.5px dashed var(--tw-server)', height: '8px' }" />Seat held for the player</span>
    </div>
    <div class="controls">
      <div class="tw-control"><TwToggle v-model="s.offline" label="Phone offline (tunnel, lift)" /><TwToggle v-model="s.background" label="App in the background" /></div>
      <TwSlider v-model="s.grace" label="Seat held for (resumeGraceMs)" :min="3" :max="30" unit=" s" />
      <TwSlider v-model="s.latency" label="Latency, one way" :min="10" :max="300" unit=" ms" />
    </div>
    <div class="actions">
      <button class="tw-btn" type="button" @click="actions.drop()">Drop the connection</button>
      <button v-if="out.status === 'lost'" class="tw-btn primary" type="button" @click="actions.fresh()">Start a new session</button>
    </div>
    <div class="readouts">
      <span>Client <b>{{ out.status }}</b></span>
      <span>Session <b>{{ out.id || 'none' }}</b></span>
      <span>Connection epoch <b>{{ out.epoch }}</b></span>
      <span>Resumed <b>{{ out.resumes }}</b> times</span>
      <span>Events waiting to be acknowledged <b>{{ out.outbox }}</b></span>
      <span v-if="out.held >= 0">Seat held <b>{{ out.held.toFixed(1) }} s</b> more</span>
      <span v-if="out.lost" :style="{ color: 'var(--tw-loss)' }">Session lost: {{ out.lost }}</span>
    </div>
  </figure>
</template>
