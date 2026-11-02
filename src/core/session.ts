import { Endpoint, type EndpointOptions, type StateMessage, type StateOptions } from './endpoint.js';
import type { Json, JsonInput } from './protocol.js';
export class GameSession {
  readonly endpoint: Endpoint;
  connected = false;
  disconnectedAt = 0;
  epoch = 0;
  /** Address of the current (or last) connection. */
  ip = '';
  /** The application JSON the client sent as `auth` with its latest hello (names, build ids). Validate before use. */
  hello: Json = null;
  /** Free for the application (player record, room membership). */
  data: unknown = undefined;
  /**
   * Smoothed round trip in ms that the server measured to this client with its own probes, or
   * null until one is answered (clients before 2.3 never answer; keep a fallback). An independent
   * server observation for lag compensation: see `selectRewindTime`. Reset on each connection.
   */
  rttMs: number | null = null;
  /** The lowest round trip measured on the current connection: the path without queueing delay. */
  minRttMs: number | null = null;
  private probeN = 0;
  private probeSentAt = -Infinity;
  private probePending = false;
  constructor(readonly id: string, readonly room: string, readonly subject: string | null, options: EndpointOptions = {}) {
    this.endpoint = new Endpoint(options);
  }
  sendEvent(data: JsonInput) { return this.endpoint.sendEvent(data); }
  /** Send what is queued now instead of at the next 60 Hz pump (latency-sensitive streams). */
  flush() { this.endpoint.flush(); }
  sendState(stream: number, data: Uint8Array, options?: StateOptions) {
    return this.endpoint.sendState(stream, data, performance.now(), options);
  }
  set onState(cb: (state: StateMessage) => void) { this.endpoint.onState = cb; }
  set onEvent(cb: (data: Json, seq: number) => void) { this.endpoint.onEvent = cb; }
  set onStateAck(cb: (stream: number, seq: number) => void) { this.endpoint.onStateAck = cb; }
  get transport(): 'rtc' | 'ws' | 'none' { return !this.connected ? 'none' : this.endpoint.fastActive ? 'rtc' : 'ws'; }
  /** @internal The number of the probe to send now, or null when none is due (one outstanding at a time). */
  nextProbe(now: number, intervalMs: number): number | null {
    if (!(intervalMs > 0) || now - this.probeSentAt < intervalMs) return null;
    this.probeN = (this.probeN + 1) >>> 0; this.probeSentAt = now; this.probePending = true;
    return this.probeN;
  }
  /** @internal A client's echo of probe n: true when it was the outstanding probe and became a sample. */
  probeAnswered(n: unknown, now: number): boolean {
    if (!this.probePending || n !== this.probeN) return false;
    this.probePending = false;
    const rtt = now - this.probeSentAt;
    if (!(rtt >= 0 && rtt < 30_000)) return false;
    this.minRttMs = this.minRttMs === null ? rtt : Math.min(this.minRttMs, rtt);
    this.rttMs = this.rttMs === null ? rtt : this.rttMs + (rtt - this.rttMs) * 0.25;
    return true;
  }
  /** @internal A new connection is a new path: its round trips start over. */
  resetRtt(): void { this.rttMs = this.minRttMs = null; this.probePending = false; this.probeSentAt = -Infinity; }
}
