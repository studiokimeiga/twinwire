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
}
