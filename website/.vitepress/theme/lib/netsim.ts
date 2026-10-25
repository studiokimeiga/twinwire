// A simulated network for the explainers. It runs on its own clock (so it can play in slow motion) and has the two
// kinds of wire Twinwire uses:
//   'ws'  a TCP-like stream: ordered and reliable, so a lost segment is resent and everything behind it waits;
//   'dg'  a UDP-like datagram path: unordered, lossy, nothing resent.
// It is a model, not a packet capture: latency, jitter and loss are what the sliders say.
import { Endpoint, decodeFrame, FrameKind, type ReliableLink, type DatagramLink, type EndpointOptions } from 'twinwire';

export type Wire = 'ws' | 'dg';
/** 1: browser to server, -1: server to browser */
export type Dir = 1 | -1;
export interface WireParams { latency: number; jitter: number; loss: number; blocked: boolean }

export interface Flight {
  wire: Wire; dir: Dir; kind: string; size: number;
  sent: number;
  /** time to cross the wire once */
  travel: number;
  /** when it reaches the far end of the wire (before any wait for an earlier lost segment) */
  reach: number;
  /** when the receiver gets it */
  due: number;
  lost: boolean;
  /** a TCP segment that was lost once: its first copy dies here (time), the resend leaves at retx */
  dies?: number; retx?: number;
  done: boolean;
  deliver: () => void;
}

export class SimNet {
  now = 0;
  speed = 1;
  readonly params: Record<Wire, WireParams> = {
    ws: { latency: 60, jitter: 10, loss: 0, blocked: false },
    dg: { latency: 60, jitter: 10, loss: 0, blocked: false },
  };
  flights: Flight[] = [];
  private tail: Record<string, number> = {};

  /** Advance by a real frame time; returns the simulated time that passed. */
  advance(realMs: number): number {
    const dt = Math.min(100, Math.max(0, realMs)) * this.speed;
    this.now += dt; this.deliver(); return dt;
  }
  deliver() {
    const due = this.flights.filter(f => !f.done && !f.lost && f.due <= this.now).sort((a, b) => a.due - b.due);
    for (const f of due) { f.done = true; try { f.deliver(); } catch (e) { console.error(e); } }
    // keep what is still on a wire (and lost packets for a moment, to show where they went)
    this.flights = this.flights.filter(f => f.lost ? this.now - f.reach < 450 : !f.done || this.now - f.due < 16);
  }
  /** Same latency/jitter/loss on both wires (the explainers' sliders). */
  set(p: Partial<Omit<WireParams, 'blocked'>>) { Object.assign(this.params.ws, p); Object.assign(this.params.dg, p); }
  send(wire: Wire, dir: Dir, kind: string, size: number, deliver: () => void): Flight {
    const p = this.params[wire], t = this.now;
    const travel = p.latency + Math.random() * p.jitter;
    const f: Flight = { wire, dir, kind, size, sent: t, travel, reach: t + travel, due: t + travel, lost: false, done: false, deliver };
    if (wire === 'dg') {
      if (p.blocked || Math.random() < p.loss) { f.lost = true; f.reach = t + travel * (0.35 + Math.random() * 0.4); }
    } else {
      const key = 'ws' + dir;
      if (Math.random() < p.loss) {
        // lost once, resent after a retransmission timeout (at least 200 ms, as TCP stacks do)
        const rto = Math.max(200, 4 * p.latency);
        f.dies = t + travel * 0.5; f.retx = t + rto; f.reach = f.retx + travel;
      }
      f.due = Math.max(this.tail[key] ?? 0, f.reach);   // in order: nothing overtakes a segment still missing
      this.tail[key] = f.due;
    }
    this.flights.push(f); return f;
  }
  reset() { this.flights = []; this.tail = {}; }
}

export function kindOf(data: string | Uint8Array): string {
  if (typeof data === 'string') { try { return String(JSON.parse(data).t ?? 'control'); } catch { return 'control'; } }
  const f = decodeFrame(data);
  if (!f) return 'bytes';
  switch (f.kind) {
    case FrameKind.state: case FrameKind.stateAcked: return 'state';
    case FrameKind.probe: return 'probe';
    case FrameKind.reply: return 'reply';
    case FrameKind.events: return f.payload.length > 2 ? 'events' : 'ack';
    case FrameKind.sack: return 'sack';
  }
  return 'bytes';
}

/** One end of a simulated wire, in the shape Endpoint attaches to. */
class SimLink implements ReliableLink, DatagramLink {
  open = true;
  readonly bufferedAmount = 0;
  constructor(private net: SimNet, private wire: Wire, private dir: Dir, private receive: (data: string | Uint8Array) => void) {}
  send(data: string | Uint8Array): boolean {
    if (!this.open) return false;
    const copy = typeof data === 'string' ? data : data.slice();
    const size = typeof data === 'string' ? data.length : data.length;
    this.net.send(this.wire, this.dir, kindOf(copy), size, () => { if (this.open) this.receive(copy); });
    return true;
  }
  close() { this.open = false; }
}

export interface Pair {
  client: Endpoint; server: Endpoint;
  /** The datagram path is up and proven both ways, as the client sees it. */
  readonly fast: boolean;
  /** Simulated time when the browser will try WebRTC again, or null. */
  retryAt: number | null;
  failures: number;
  /** Which path brought the event being delivered right now. */
  via: Wire;
  pump(): void;
  dispose(): void;
}

/**
 * Two real Twinwire endpoints, a browser's and the server's, joined by a simulated WebSocket and datagram path. When
 * the datagram path stops proving itself, it is dropped and tried again later with backoff (3 s, 6 s, 12 s...), as
 * GameClient does with WebRTC.
 */
export function endpointPair(net: SimNet, options: EndpointOptions = {}): Pair {
  const o = { ...options, now: () => net.now };
  const client = new Endpoint(o), server = new Endpoint(o);
  const pair: Pair = {
    client, server, retryAt: null, failures: 0, via: 'ws',
    get fast() { return client.fastActive; },
    pump() {
      if (pair.retryAt !== null && net.now >= pair.retryAt) { pair.retryAt = null; attachDatagrams(); }
      client.pump(); server.pump();
    },
    dispose() { for (const l of links) l.close(); },
  };
  const links: SimLink[] = [];
  const into = (e: Endpoint, wire: Wire) => (data: string | Uint8Array) => {
    pair.via = wire;
    if (typeof data === 'string') e.receiveControl(JSON.parse(data)); else e.receiveBinary(data, wire === 'dg' ? 'rtc' : 'ws');
  };
  const up = new SimLink(net, 'ws', 1, into(server, 'ws')), down = new SimLink(net, 'ws', -1, into(client, 'ws'));
  links.push(up, down);
  client.attach(1, up); server.attach(1, down);
  let dgUp: SimLink | null = null, dgDown: SimLink | null = null;
  function attachDatagrams() {
    dgUp = new SimLink(net, 'dg', 1, into(server, 'dg')); dgDown = new SimLink(net, 'dg', -1, into(client, 'dg'));
    links.push(dgUp, dgDown);
    client.attachDatagram(dgUp); server.attachDatagram(dgDown);
  }
  const down_ = () => {
    // either end gave up on the datagram path: both drop it, and the browser tries again later
    dgUp?.close(); dgDown?.close(); dgUp = dgDown = null;
    client.dropDatagram(false); server.dropDatagram(false);
    if (pair.retryAt === null) pair.retryAt = net.now + Math.min(60000, 3000 * 2 ** Math.min(pair.failures++, 4));
  };
  client.onFastDown = down_; server.onFastDown = down_;
  attachDatagrams();
  return pair;
}
