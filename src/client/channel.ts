import { GameClient, type ClientOptions } from './client.js';
import type { StateReceiver } from './state.js';
import { channelName, channelSchema, encodeChannel, decodeChannel, namedEvent, type LatestChannels, type ChannelHandler } from '../core/channels.js';
import type { JsonInput } from '../core/protocol.js';
export interface EventClientOptions extends ClientOptions { latest?: LatestChannels; stateMaxAgeMs?: number }
/** Named JSON events and states on one GameClient. A pause is not a terminal disconnect. */
export class EventClient {
  readonly net: GameClient;
  private schema: Map<string, number>;
  private handlers = new Map<string, ChannelHandler>();
  private receivers = new Map<string, StateReceiver>();
  private connected: (error?: Error) => void = () => {};
  private disconnected: () => void = () => {};
  onPause: () => void = () => {};
  onResume: () => void = () => {};
  onReset: () => void = () => {};
  constructor(options: EventClientOptions) {
    this.schema = channelSchema(options.latest);
    const age = options.stateMaxAgeMs ?? 100;
    if (!Number.isFinite(age) || age < 0 || age > 30000) throw new RangeError('stateMaxAgeMs must be 0 to 30000');
    this.net = new GameClient(options);
    for (const [name, stream] of this.schema) {
      this.receivers.set(name, this.net.receiveState({
        stream, maxExtrapolationMs: age, reset: () => this.onReset(),
        apply: state => {
          const data = decodeChannel(state.data), handler = this.handlers.get(name);
          if (data === undefined || !handler) return false;
          return handler(data) !== false;
        },
      }));
    }
    this.net.onEvent = event => { const message = namedEvent(event); if (message) this.handlers.get(message.name)?.(message.data); };
    let wasOnline = false;
    this.net.onStatus = status => {
      if (status === 'online') wasOnline = true;
      else if (wasOnline && (status === 'paused' || status === 'connecting')) { wasOnline = false; this.onPause(); }
      if (status === 'lost' || status === 'closed') this.disconnected();
    };
    this.net.onSession = info => { if (info.resumed) this.onResume(); this.connected(); };
  }
  get id(): string { return this.net.id ?? ''; }
  get transport() { return this.net.transport; }
  on(name: string, handler: ChannelHandler): void {
    if (!channelName(name)) throw new TypeError('Invalid channel name');
    this.handlers.set(name, handler);
  }
  onConnect(handler: (error?: Error) => void): void { this.connected = handler; }
  /** Called only when the session is closed/lost. Temporary interruptions use onPause and auto-resume. */
  onDisconnect(handler: () => void): void { this.disconnected = handler; }
  ready(name: string): boolean { return this.receivers.get(name)?.ready ?? false; }
  emit(name: string, data: JsonInput = null): number {
    if (!channelName(name)) throw new TypeError('Invalid channel name');
    const stream = this.schema.get(name);
    return stream === undefined ? this.net.sendEvent({ name, data }) : this.net.sendState(stream, encodeChannel(data));
  }
  connect(): void { this.net.connect(); }
  close(): void { this.net.close(); }
}
/** Connect immediately after listeners in the current task have been installed. */
export function createEventClient(options: EventClientOptions): EventClient {
  const client = new EventClient(options); queueMicrotask(() => { if (client.net.status !== 'closed') client.connect(); }); return client;
}
export type { LatestChannels, ChannelHandler } from '../core/channels.js';
