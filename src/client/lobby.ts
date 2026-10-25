import type { Json } from '../core/protocol.js';
import {
  LOBBY_KEY, isLobbyMessage, normalizeCode,
  type CreateRequest, type MemberView, type QuickPlayRequest, type RoomView,
} from '../core/lobby.js';
import type { GameClient } from './client.js';
export type { CreateRequest, MemberView, QuickPlayRequest, RoomView } from '../core/lobby.js';
interface Pending { resolve: (room: RoomView | null) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
/**
 * Rooms on top of a GameClient: create a private room with a code, join by code, quick play into a public room,
 * ready up, and follow who is in the room. Requests ride on reliable events, so they survive reconnects.
 */
export class LobbyClient {
  room: RoomView | null = null;
  onRoom: (room: RoomView | null) => void = () => {};
  /** The room was left without asking (kicked, replaced, closed, session expired). */
  onLeft: (reason: string) => void = () => {};
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private off: (() => void)[];
  constructor(readonly client: GameClient, readonly requestTimeoutMs = 20000) {
    this.off = [
      client.intercept(d => {
        if (!isLobbyMessage(d)) return false;
        this.message(d as Record<string, Json>); return true;
      }),
      client.on('session', ({ resumed }) => { if (!resumed) this.drop('new session'); }),
      client.on('lost', ({ reason }) => this.drop(reason)),
    ];
  }
  dispose() { for (const f of this.off) f(); this.drop('disposed', false); }
  get me(): MemberView | null { return this.room?.members.find(m => m.seat === this.room!.you) ?? null; }
  get isHost(): boolean { return !!this.me?.host; }
  /** Milliseconds until the ready countdown ends, or null when none is running. */
  countdownMs(): number | null {
    const end = this.room?.countdownEndsAt;
    if (end == null || !this.client.clock.synced) return null;
    return Math.max(0, end - this.client.clock.serverTime(performance.now()));
  }
  create(o: CreateRequest = {}) { return this.request({ [LOBBY_KEY]: 'create', ...o } as Record<string, Json>); }
  join(code: string, o: { name?: string; memberMeta?: Record<string, Json> } = {}) {
    const c = normalizeCode(code);
    if (!c) return Promise.reject(new Error('That is not a room code'));
    return this.request({ [LOBBY_KEY]: 'join', code: c, ...o } as Record<string, Json>);
  }
  quickPlay(o: QuickPlayRequest = {}) { return this.request({ [LOBBY_KEY]: 'quick', ...o } as unknown as Record<string, Json>); }
  async leave() { await this.request({ [LOBBY_KEY]: 'leave' }); this.set(null); }
  setReady(ready: boolean) { return this.request({ [LOBBY_KEY]: 'ready', ready }); }
  setName(name: string) { return this.request({ [LOBBY_KEY]: 'name', name }); }
  setMeta(meta: Record<string, Json>) { return this.request({ [LOBBY_KEY]: 'meta', meta }); }
  kick(seat: number) { return this.request({ [LOBBY_KEY]: 'kick', seat }); }
  private request(body: Record<string, Json>): Promise<RoomView | null> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('The room server did not answer')); }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.client.sendEvent({ ...body, id }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e instanceof Error ? e : new Error(String(e))); }
    });
  }
  private set(room: RoomView | null) { this.room = room; try { this.onRoom(room); } catch { /* app callback */ } }
  private message(d: Record<string, Json>) {
    const op = d[LOBBY_KEY];
    if (op === 'res' && typeof d.id === 'number') {
      const p = this.pending.get(d.id); if (!p) return;
      this.pending.delete(d.id); clearTimeout(p.timer);
      if (d.ok === true) {
        const room = (d.room ?? null) as unknown as RoomView | null;
        if (room || this.room) this.set(room);
        p.resolve(room);
      } else p.reject(new Error(typeof d.error === 'string' ? d.error : 'Request refused'));
      return;
    }
    if (op === 'room' && d.room && typeof d.room === 'object') { this.set(d.room as unknown as RoomView); return; }
    if (op === 'left') { const had = !!this.room; this.set(null); if (had) try { this.onLeft(typeof d.reason === 'string' ? d.reason : 'left'); } catch { /* app */ } }
  }
  private drop(reason: string, notify = true) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
    if (this.room) { this.set(null); if (notify) try { this.onLeft(reason); } catch { /* app */ } }
  }
}
