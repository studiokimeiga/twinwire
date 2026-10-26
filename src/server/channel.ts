import { createGameServer, type GameServerOptions, type GameServer, type GameSession } from './server.js';
import { channelName, channelSchema, encodeChannel, decodeChannel, namedEvent, type LatestChannels, type ChannelHandler } from '../core/channels.js';
import type { JsonInput } from '../core/protocol.js';
export interface EventServerOptions extends GameServerOptions { namespace: string; latest?: LatestChannels }
export class ServerEventChannel {
  readonly rooms = new Set<string>();
  private handlers = new Map<string, ChannelHandler>();
  private disconnected: () => void = () => {};
  onPause: () => void = () => {};
  onResume: () => void = () => {};
  constructor(readonly server: EventServer, readonly session: GameSession) {
    session.onEvent = event => { const message = namedEvent(event); if (message) this.handlers.get(message.name)?.(message.data); };
    const streams = new Map([...server.schema].map(([name, stream]) => [stream, name]));
    session.onState = state => {
      const name = streams.get(state.stream); if (!name) return;
      const data = decodeChannel(state.data); if (data !== undefined) this.handlers.get(name)?.(data);
    };
  }
  get id(): string { return this.session.id; }
  get connected(): boolean { return this.session.connected; }
  get transport() { return this.session.transport; }
  get broadcast() { return { emit: (name: string, data: JsonInput = null) => this.server.broadcast(name, data, this.id) }; }
  on(name: string, handler: ChannelHandler): void {
    if (!channelName(name)) throw new TypeError('Invalid channel name');
    this.handlers.set(name, handler);
  }
  /** Expiry/explicit leave only. A socket pause preserves handlers, rooms and game state. */
  onDisconnect(handler: () => void): void { this.disconnected = handler; }
  expire(): void { for (const room of [...this.rooms]) this.leave(room); this.disconnected(); }
  join(room: string): void {
    if (typeof room !== 'string' || !room || room.length > 128) throw new TypeError('Invalid room');
    if (this.rooms.has(room)) return;
    if (this.rooms.size >= 32) throw new RangeError('Too many rooms');
    this.rooms.add(room); this.server.join(room, this);
  }
  leave(room?: string): void { if (room === undefined) { for (const name of [...this.rooms]) this.leave(name); return; } this.rooms.delete(room); this.server.leave(room, this); }
  emit(name: string, data: JsonInput = null): number {
    if (!channelName(name)) throw new TypeError('Invalid channel name');
    const stream = this.server.schema.get(name);
    return stream === undefined ? this.session.sendEvent({ name, data }) : this.session.sendState(stream, encodeChannel(data));
  }
  close(): void { this.server.game.endSession(this.session); }
}
/** A small named-message facade; the GameServer still owns sessions, probes and delivery. */
export class EventServer {
  readonly channels = new Map<string, ServerEventChannel>();
  private rooms = new Map<string, Set<ServerEventChannel>>();
  private connection: (channel: ServerEventChannel) => void = () => {};
  constructor(readonly game: GameServer, readonly schema: Map<string, number>) {
    game.on('session', (session, resumed) => {
      if (resumed) { this.channels.get(session.id)?.onResume(); return; }
      const channel = new ServerEventChannel(this, session); this.channels.set(channel.id, channel); this.connection(channel);
    });
    game.on('disconnect', session => this.channels.get(session.id)?.onPause());
    game.on('expire', session => {
      const channel = this.channels.get(session.id); this.channels.delete(session.id); channel?.expire();
    });
  }
  get roomCount(): number { return this.rooms.size; }
  onConnection(handler: (channel: ServerEventChannel) => void): void { this.connection = handler; }
  join(room: string, channel: ServerEventChannel): void {
    let members = this.rooms.get(room); if (!members) this.rooms.set(room, members = new Set()); members.add(channel);
  }
  leave(room: string, channel: ServerEventChannel): void {
    const members = this.rooms.get(room); members?.delete(channel); if (!members?.size) this.rooms.delete(room);
  }
  room(room: string) { return { emit: (name: string, data: JsonInput = null) => { for (const channel of this.rooms.get(room) ?? []) channel.emit(name, data); } }; }
  broadcast(name: string, data: JsonInput = null, exclude?: string): void {
    for (const channel of this.channels.values()) if (channel.id !== exclude) channel.emit(name, data);
  }
  emit(name: string, data: JsonInput = null): void { this.broadcast(name, data); }
  listen(): Promise<number> { return this.game.listen(); }
  async close(): Promise<void> { await this.game.close(); this.channels.clear(); this.rooms.clear(); }
}
export async function createEventServer(options: EventServerOptions): Promise<EventServer> {
  const schema = channelSchema(options.latest), auth = options.authenticate;
  if (!/^[\w:.-]{1,64}$/.test(options.namespace)) throw new TypeError('Invalid namespace');
  const game = await createGameServer({ ...options, authenticate: request =>
    request.room !== options.namespace ? null : auth ? auth(request) : options.namespace });
  return new EventServer(game, schema);
}
export type { LatestChannels, ChannelHandler } from '../core/channels.js';
