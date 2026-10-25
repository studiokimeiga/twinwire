import { Endpoint } from '../dist/core/endpoint.js';
import { readControl } from '../dist/core/protocol.js';
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function until(fn, timeout = 3000) {
  const end = performance.now() + timeout;
  while (!fn()) { if (performance.now() > end) throw new Error('Condition timed out'); await sleep(5); }
}
export function pair(options = {}) {
  let now = 0, epoch = 1;
  const a = new Endpoint({ now: () => now, probeIntervalMs: 20, probeTimeoutMs: 100, ...options });
  const b = new Endpoint({ now: () => now, probeIntervalMs: 20, probeTimeoutMs: 100, ...options });
  const reliable = [], fast = [];
  const blocked = { a: false, b: false, bufferedA: 0, bufferedB: 0 };
  const copy = data => typeof data === 'string' ? data : data.slice();
  function attach() {
    a.attach(epoch, { open: true, get bufferedAmount() { return blocked.bufferedA; }, send: d => (reliable.push([b, copy(d)]), true), close() {} });
    b.attach(epoch, { open: true, get bufferedAmount() { return blocked.bufferedB; }, send: d => (reliable.push([a, copy(d)]), true), close() {} });
  }
  function rtc() {
    a.attachDatagram({ open: true, bufferedAmount: 0, send: d => { if (!blocked.a) fast.push([b, d.slice()]); return true; }, close() {} });
    b.attachDatagram({ open: true, bufferedAmount: 0, send: d => { if (!blocked.b) fast.push([a, d.slice()]); return true; }, close() {} });
  }
  function deliver() {
    let guard = 0;
    while ((reliable.length || fast.length) && guard++ < 10000) {
      const r = reliable.shift(); if (r) { const [peer, data] = r; if (typeof data === 'string') peer.receiveControl(readControl(data)); else peer.receiveBinary(data, 'ws'); }
      const f = fast.shift(); if (f) f[0].receiveBinary(f[1], 'rtc');
    }
    if (guard >= 10000) throw new Error('Loop');
  }
  attach();
  return { a, b, reliable, fast, blocked, rtc, deliver,
    get now() { return now; },
    advance(ms = 20) { now += ms; a.pump(); b.pump(); deliver(); },
    reconnect() { epoch++; reliable.length = fast.length = 0; attach(); },
  };
}
