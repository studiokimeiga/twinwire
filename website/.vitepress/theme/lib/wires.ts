// Drawing for the two-wires view: a browser and a server, the WebSocket above, the datagram path below, and every
// packet in flight in the shape of its kind.
import type { Frame } from './stage';
import { rrect, label } from './stage';
import type { Flight, Pair, SimNet } from './netsim';

export interface WireLayout { x0: number; x1: number; yWs: number; yDg: number; compact: boolean }

export function layout(w: number, h: number, compact: boolean): WireLayout {
  const pad = compact ? 58 : Math.min(96, Math.max(64, w * 0.12));
  const mid = h / 2, gap = compact ? Math.min(46, h * 0.23) : Math.min(56, h * 0.2);
  return { x0: pad, x1: w - pad, yWs: mid - gap, yDg: mid + gap, compact };
}

function phone(f: Frame, x: number, y: number, name: string) {
  const { g, c } = f;
  rrect(g, x - 13, y - 23, 26, 46, 6); g.fillStyle = c.panel; g.fill(); g.lineWidth = 2; g.strokeStyle = c.ink; g.stroke();
  g.fillStyle = c.ink; g.fillRect(x - 4, y + 17, 8, 2);
  label(g, name, x, y + 37, c.ink2, `600 13px ${c.body}`, 'center');
}
function server(f: Frame, x: number, y: number, name: string) {
  const { g, c } = f;
  for (let i = 0; i < 3; i++) { rrect(g, x - 18, y - 22 + i * 15, 36, 12, 3); g.fillStyle = c.panel; g.fill(); g.lineWidth = 2; g.strokeStyle = c.ink; g.stroke(); g.fillStyle = c.ink; g.fillRect(x + 9, y - 17 + i * 15, 4, 2); }
  label(g, name, x, y + 37, c.ink2, `600 13px ${c.body}`, 'center');
}

function glyph(f: Frame, kind: string, x: number, y: number, color: string, alpha: number) {
  const { g, c } = f;
  g.globalAlpha = alpha; g.fillStyle = color; g.strokeStyle = color; g.lineWidth = 1.6;
  switch (kind) {
    case 'state': rrect(g, x - 7, y - 4, 14, 8, 2.5); g.fill(); break;
    case 'event': case 'events': g.beginPath(); g.moveTo(x, y - 6); g.lineTo(x + 6, y); g.lineTo(x, y + 6); g.lineTo(x - 6, y); g.closePath(); g.fill(); g.strokeStyle = c.panel; g.lineWidth = 1; g.stroke(); break;
    case 'probe': case 'reply': g.beginPath(); g.arc(x, y, 3.4, 0, Math.PI * 2); g.stroke(); break;
    case 'ack': case 'sack': g.strokeRect(x - 3, y - 3, 6, 6); break;
    default: g.beginPath(); g.arc(x, y, 2.4, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
}
function cross(f: Frame, x: number, y: number, alpha: number) {
  const { g, c } = f;
  g.globalAlpha = alpha; g.strokeStyle = c.loss; g.lineWidth = 2;
  g.beginPath(); g.moveTo(x - 4, y - 4); g.lineTo(x + 4, y + 4); g.moveTo(x + 4, y - 4); g.lineTo(x - 4, y + 4); g.stroke();
  g.globalAlpha = 1;
}

export function drawWires(f: Frame, net: SimNet, pair: Pair, L: WireLayout, names = { client: 'Browser', server: 'Server' }) {
  const { g, c } = f, now = net.now;
  const dgUp = pair.client.fastActive || pair.server.fastActive, dgTrying = !dgUp && pair.retryAt === null;
  const span = L.x1 - L.x0 - 52, left = L.x0 + 26;
  // the wires
  g.lineCap = 'round';
  g.strokeStyle = c.ws; g.lineWidth = 3; g.beginPath(); g.moveTo(L.x0 + 18, L.yWs); g.lineTo(L.x1 - 22, L.yWs); g.stroke();
  g.setLineDash(dgUp ? [] : [6, 7]); g.strokeStyle = dgUp ? c.dgFill : c.rule; g.lineWidth = 3;
  g.beginPath(); g.moveTo(L.x0 + 18, L.yDg); g.lineTo(L.x1 - 22, L.yDg); g.stroke(); g.setLineDash([]);
  const small = `600 12.5px ${c.body}`;
  label(g, 'WebSocket', left, L.yWs - 17, c.ws, small);
  const dgText = net.params.dg.blocked ? 'Datagrams (UDP blocked)' : dgUp ? 'WebRTC datagrams' : pair.retryAt !== null
    ? `Datagrams: trying again in ${Math.max(0, (pair.retryAt - now) / 1000).toFixed(1)} s` : dgTrying ? 'Datagrams: proving the path' : 'Datagrams';
  label(g, dgText, left, L.yDg + 19, dgUp ? c.dg : c.ink3, small);
  phone(f, L.x0 - 8, (L.yWs + L.yDg) / 2, names.client);
  server(f, L.x1 + 6, (L.yWs + L.yDg) / 2, names.server);

  // packets
  const waiting: Record<string, Flight[]> = { '1': [], '-1': [] };
  for (const p of net.flights) {
    const y = (p.wire === 'ws' ? L.yWs : L.yDg) + (p.dir === 1 ? -6 : 6);
    const from = p.dir === 1 ? left : left + span, to = p.dir === 1 ? left + span : left;
    const at = (u: number) => from + (to - from) * Math.max(0, Math.min(1, u));
    const color = p.wire === 'ws' ? c.ws : c.dgFill;
    if (p.lost) {
      if (now < p.reach) glyph(f, p.kind, at((now - p.sent) / p.travel), y, color, 1);
      else { const fade = Math.max(0, 1 - (now - p.reach) / 450), x = at((p.reach - p.sent) / p.travel); glyph(f, p.kind, x, y, color, fade * 0.5); cross(f, x, y, fade); }
      continue;
    }
    if (p.dies !== undefined && p.retx !== undefined) {
      if (now < p.dies) { glyph(f, p.kind, at(0.5 * (now - p.sent) / (p.dies - p.sent)), y, color, 1); continue; }
      if (now < p.retx) { const fade = Math.max(0, 1 - (now - p.dies) / 350), x = at(0.5); glyph(f, p.kind, x, y, color, fade * 0.5); cross(f, x, y, fade); continue; }
      if (now < p.reach) { glyph(f, p.kind, at((now - p.retx) / (p.reach - p.retx)), y, color, 1); continue; }
    } else if (now < p.reach) { glyph(f, p.kind, at((now - p.sent) / (p.reach - p.sent)), y, color, 1); continue; }
    if (now < p.due) waiting[String(p.dir)]!.push(p);   // arrived, but held behind a segment still being resent
  }
  for (const dir of ['1', '-1']) {
    const list = waiting[dir]!.sort((a, b) => a.due - b.due); if (!list.length) continue;
    const toRight = dir === '1', y = L.yWs + (toRight ? -6 : 6);
    list.forEach((p, i) => glyph(f, p.kind, (toRight ? left + span : left) + (toRight ? -1 : 1) * (8 + i * 9), y + (toRight ? -9 : 9), c.ws, 0.85));
    if (!L.compact) label(g, 'waiting behind a resent segment', toRight ? left + span - 4 : left + 4, y + (toRight ? -22 : 22), c.ws, `600 11.5px ${c.body}`, toRight ? 'right' : 'left');
  }
}
