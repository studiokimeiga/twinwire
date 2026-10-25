import { randomInt } from 'node:crypto';
import type { StateMessage } from '../core/endpoint.js';
import type { Json } from '../core/protocol.js';
import {
  CODE_ALPHABET, LOBBY_KEY, cleanMeta, cleanName, isLobbyMessage, metaMatches, normalizeCode,
  type CreateRequest, type JoinRequest, type MemberView, type QuickPlayRequest, type RoomView, type Visibility,
} from '../core/lobby.js';
import type { GameServer, GameSession } from './server.js';
export interface LobbyOptions {
  /** Seats per room unless a request asks for fewer (default 4, at most 64). */
  maxMembers?: number;
  codeLength?: number;
  /** A room with no members left closes after this long (default 30 s; a later join by code cancels it). */
  emptyCloseMs?: number;
  maxRooms?: number;
  /** Rooms one address may create per hour (default 30). */
  maxRoomsPerIpPerHour?: number;
  /** Phases a code can join (default lobby and playing: drop-in). */
  joinablePhases?: string[];
  /** Phases quick play may drop a player into (default ['lobby']). */
  quickPlayPhases?: string[];
  /** When a room is full, free the seat of whoever has been disconnected longest (default true). */
  evictDisconnected?: boolean;
  /** Ready-up: once every connected member is ready (and at least minMembers), count down and start. false: no ready. */
  ready?: false | { countdownMs?: number; minMembers?: number };
  allowHostKick?: boolean;
  /** Member meta keys a client may set (setMeta, memberMeta on join). Default: any. Keys the server sets stay out of this list. */
  clientMetaKeys?: string[];
  /** Return an error message to refuse. */
  canCreate?: (session: GameSession, request: CreateRequest) => string | null | void;
  canJoin?: (room: Room, session: GameSession, request: JoinRequest | QuickPlayRequest) => string | null | void;
}
export interface Member {
  readonly session: GameSession; readonly room: Room; readonly seat: number; readonly joinedAt: number;
  name: string; ready: boolean; connected: boolean; disconnectedAt: number; meta: Record<string, Json>;
  /** Free for the application (player id in the simulation, score). */
  data: unknown;
}
export class Room {
  phase = 'lobby';
  meta: Record<string, Json>;
  /** Free for the application (its simulation, world). */
  data: unknown = undefined;
  readonly members = new Map<string, Member>();
  host: Member | null = null;
  countdownEndsAt: number | null = null;
  readonly createdAt = Date.now();
  emptySince: number | null = null;
  closed = false;
  /** @internal */ countdown?: ReturnType<typeof setTimeout>;
  constructor(readonly lobby: Lobby, readonly code: string, readonly mode: string, public visibility: Visibility,
    readonly maxMembers: number, meta: Record<string, Json>) { this.meta = meta; }
  get connectedCount() { let n = 0; for (const m of this.members.values()) if (m.connected) n++; return n; }
  memberAt(seat: number): Member | undefined { for (const m of this.members.values()) if (m.seat === seat) return m; return undefined; }
  view(viewer: Member | null): RoomView {
    const members: MemberView[] = [...this.members.values()].sort((a, b) => a.seat - b.seat).map(m => ({
      seat: m.seat, name: m.name, ready: m.ready, connected: m.connected, host: m === this.host, meta: m.meta,
    }));
    return { code: this.code, mode: this.mode, visibility: this.visibility, phase: this.phase, maxMembers: this.maxMembers,
      meta: this.meta, you: viewer?.seat ?? -1, members, countdownEndsAt: this.countdownEndsAt };
  }
  /** Reliable event to every member (disconnected ones get it on resume). Returns members whose outbox was full. */
  broadcast(data: Json, except?: Member): Member[] {
    const rejected: Member[] = [];
    for (const m of this.members.values()) if (m !== except && !this.send(m, data)) rejected.push(m);
    return rejected;
  }
  send(member: Member, data: Json): boolean {
    try { member.session.sendEvent(data); return true; } catch (e) { this.lobby.report(e); return false; }
  }
  setPhase(phase: string): void {
    if (typeof phase !== 'string' || !phase || phase.length > 24) throw new RangeError('Invalid phase');
    if (phase === this.phase) return;
    this.phase = phase; this.lobby.cancelCountdown(this);
    if (phase === 'lobby') for (const m of this.members.values()) m.ready = false;
    this.lobby.changed(this);
  }
  setMeta(patch: Record<string, Json>): void { Object.assign(this.meta, patch); this.lobby.changed(this); }
  setVisibility(v: Visibility): void { this.visibility = v; this.lobby.changed(this); }
  /** Start now (skips the ready countdown). */
  start(): void { this.lobby.startRoom(this); }
  close(reason = 'closed'): void { this.lobby.closeRoom(this, reason); }
}
type Reply = { ok: true; room: RoomView | null } | { ok: false; error: string };
export class Lobby {
  readonly rooms = new Map<string, Room>();
  private bySession = new Map<string, Member>();
  private creations = new Map<string, number[]>();
  private timer: ReturnType<typeof setInterval>;
  private off: (() => void)[];
  readonly options: Required<Omit<LobbyOptions, 'canCreate' | 'canJoin' | 'ready' | 'clientMetaKeys'>> & Pick<LobbyOptions, 'canCreate' | 'canJoin' | 'ready' | 'clientMetaKeys'>;
  /** A room was made by request; `request.init` carries the creator's setup data (validate it). */
  onCreate: (room: Room, creator: GameSession, request: CreateRequest) => void = () => {};
  onJoin: (room: Room, member: Member) => void = () => {};
  onLeave: (room: Room, member: Member, reason: string) => void = () => {};
  onDisconnect: (room: Room, member: Member) => void = () => {};
  /** A member's session is back on a new connection: after a drop, or a reloaded page taking it over. */
  onReconnect: (room: Room, member: Member) => void = () => {};
  onStart: (room: Room) => void = () => {};
  onClose: (room: Room, reason: string) => void = () => {};
  /** Application events (anything that is not a lobby request). room/member are null outside a room. */
  onEvent: (room: Room | null, member: Member | null, data: Json, session: GameSession) => void = () => {};
  onState: (room: Room | null, member: Member | null, state: StateMessage, session: GameSession) => void = () => {};
  onError: (error: Error) => void = () => {};
  constructor(readonly server: GameServer, o: LobbyOptions = {}) {
    this.options = {
      maxMembers: o.maxMembers ?? 4, codeLength: o.codeLength ?? 4, emptyCloseMs: o.emptyCloseMs ?? 30_000,
      maxRooms: o.maxRooms ?? 500, maxRoomsPerIpPerHour: o.maxRoomsPerIpPerHour ?? 30,
      joinablePhases: o.joinablePhases ?? ['lobby', 'playing'], quickPlayPhases: o.quickPlayPhases ?? ['lobby'],
      evictDisconnected: o.evictDisconnected ?? true, allowHostKick: o.allowHostKick ?? true,
      ready: o.ready === undefined ? { countdownMs: 3000, minMembers: 1 } : o.ready, canCreate: o.canCreate, canJoin: o.canJoin, clientMetaKeys: o.clientMetaKeys,
    };
    const opt = this.options;
    if (!Number.isInteger(opt.maxMembers) || opt.maxMembers < 1 || opt.maxMembers > 64 ||
        !Number.isInteger(opt.codeLength) || opt.codeLength < 3 || opt.codeLength > 12) throw new RangeError('Invalid lobby options');
    this.off = [
      server.on('session', (s, resumed) => this.attach(s, resumed)),
      server.on('disconnect', s => this.disconnected(s)),
      server.on('expire', s => { const m = this.bySession.get(s.id); if (m) this.removeMember(m, 'expired'); }),
    ];
    for (const s of server.sessions.values()) if (s.connected) this.attach(s, false);
    this.timer = setInterval(() => this.sweep(), 1000);
    (this.timer as { unref?: () => void }).unref?.();
  }
  /** @internal */ report(e: unknown) { try { this.onError(e instanceof Error ? e : new Error(String(e))); } catch { /* ignore */ } }
  memberOf(session: GameSession): Member | undefined { return this.bySession.get(session.id); }
  roomOf(session: GameSession): Room | undefined { return this.bySession.get(session.id)?.room; }
  dispose(): void { clearInterval(this.timer); for (const f of this.off) f(); for (const r of [...this.rooms.values()]) this.closeRoom(r, 'shutdown'); }
  private attach(s: GameSession, resumed: boolean) {
    s.onEvent = data => this.event(s, data);
    s.onState = state => { const m = this.bySession.get(s.id); try { this.onState(m?.room ?? null, m ?? null, state, s); } catch (e) { this.report(e); } };
    // back on a new connection: after a drop, or taking over from a socket the server hasn't seen close yet (a reloaded
    // page resuming its checkpoint). Either way the client is a fresh instance, so the game re-sends what it needs.
    const m = this.bySession.get(s.id);
    if (m && resumed) {
      m.connected = true; m.disconnectedAt = 0;
      // with everyone gone the host fell back to a disconnected member: the first one back takes it
      if (!m.room.host?.connected) this.pickHost(m.room);
      // back unready (a drop clears ready): a countdown that started without them waits for them, as for a join
      if (!m.ready) this.cancelCountdown(m.room);
      this.safe(() => this.onReconnect(m.room, m)); this.changed(m.room);
    }
  }
  private disconnected(s: GameSession) {
    const m = this.bySession.get(s.id); if (!m || !m.connected) return;
    m.connected = false; m.disconnectedAt = Date.now(); m.ready = false;
    if (m.room.host === m) this.pickHost(m.room);
    this.cancelCountdown(m.room);
    this.safe(() => this.onDisconnect(m.room, m)); this.changed(m.room);
  }
  private safe(fn: () => void) { try { fn(); } catch (e) { this.report(e); } }
  private event(s: GameSession, data: Json) {
    if (!isLobbyMessage(data)) {
      const m = this.bySession.get(s.id);
      this.safe(() => this.onEvent(m?.room ?? null, m ?? null, data, s)); return;
    }
    const d = data as Record<string, Json>, id = d.id, op = d[LOBBY_KEY];
    const reply = (r: Reply) => { if (typeof id === 'number') this.send(s, { [LOBBY_KEY]: 'res', id, ...r } as Json); };
    try {
      switch (op) {
        case 'create': return reply(this.create(s, d as unknown as CreateRequest));
        case 'join': return reply(this.join(s, d as unknown as JoinRequest));
        case 'quick': return reply(this.quickPlay(s, d as unknown as QuickPlayRequest));
        case 'leave': { const m = this.bySession.get(s.id); if (m) this.removeMember(m, 'left', false); return reply({ ok: true, room: null }); }
        case 'ready': return reply(this.member(s, m => { this.setReady(m, d.ready === true); }));
        case 'name': return reply(this.member(s, m => { const n = cleanName(d.name); if (n) m.name = n; this.changed(m.room); }));
        case 'meta': return reply(this.member(s, m => {
          const meta = this.clientMeta(d.meta); if (!meta) throw new Error('invalid meta');
          const merged = { ...m.meta, ...meta };
          if (Object.keys(merged).length > 32 || JSON.stringify(merged).length > 4096) throw new Error('too much meta');
          m.meta = merged; this.changed(m.room);
        }));
        case 'kick': return reply(this.member(s, m => {
          if (!this.options.allowHostKick || m.room.host !== m) throw new Error('only the host can do that');
          const target = typeof d.seat === 'number' ? m.room.memberAt(d.seat) : undefined;
          if (!target || target === m) throw new Error('no such player');
          this.removeMember(target, 'kicked');
        }));
        default: return reply({ ok: false, error: 'unknown request' });
      }
    } catch (e) { reply({ ok: false, error: e instanceof Error ? e.message.slice(0, 120) : 'error' }); }
  }
  private member(s: GameSession, fn: (m: Member) => void): Reply {
    const m = this.bySession.get(s.id); if (!m) return { ok: false, error: 'not in a room' };
    fn(m); return { ok: true, room: m.room.view(m) };
  }
  private send(s: GameSession, data: Json) { try { s.sendEvent(data); } catch (e) { this.report(e); } }
  /** A client's meta, cleaned and limited to the keys clients may set (null: invalid). */
  private clientMeta(v: unknown): Record<string, Json> | null {
    const meta = cleanMeta(v), keys = this.options.clientMetaKeys;
    if (!meta || !keys) return meta;
    for (const k of Object.keys(meta)) if (!keys.includes(k)) delete meta[k];
    return meta;
  }
  private newCode(): string {
    for (let tries = 0; tries < 1000; tries++) {
      let c = ''; for (let i = 0; i < this.options.codeLength; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
    throw new Error('no free room codes');
  }
  private rateOk(ip: string): boolean {
    const now = Date.now(), list = (this.creations.get(ip) ?? []).filter(t => now - t < 3600_000);
    if (list.length >= this.options.maxRoomsPerIpPerHour) { this.creations.set(ip, list); return false; }
    list.push(now); this.creations.set(ip, list); return true;
  }
  /** Create a room on the server's own initiative (no creator). */
  createRoom(o: { mode?: string; visibility?: Visibility; maxMembers?: number; meta?: Record<string, Json> } = {}): Room {
    if (this.rooms.size >= this.options.maxRooms) throw new Error('the server is busy: try again soon');
    const max = Math.min(this.options.maxMembers, Number.isInteger(o.maxMembers) && o.maxMembers! > 0 ? o.maxMembers! : this.options.maxMembers);
    const mode = typeof o.mode === 'string' && /^[\w.-]{1,32}$/.test(o.mode) ? o.mode : 'default';
    const room = new Room(this, this.newCode(), mode, o.visibility === 'public' ? 'public' : 'private', max, o.meta ?? {});
    this.rooms.set(room.code, room); room.emptySince = Date.now();
    return room;
  }
  private create(s: GameSession, req: CreateRequest): Reply {
    const meta = cleanMeta(req.meta), memberMeta = this.clientMeta(req.memberMeta);
    if (!meta || !memberMeta) return { ok: false, error: 'invalid meta' };
    const refused = this.options.canCreate?.(s, req);
    if (refused) return { ok: false, error: refused };
    if (!this.rateOk(s.ip)) return { ok: false, error: 'too many rooms made from here: try again later' };
    const room = this.createRoom({ ...req, meta });
    this.safe(() => this.onCreate(room, s, req));
    if (room.closed) return { ok: false, error: 'room closed' };
    return this.seat(room, s, req.name, memberMeta);
  }
  private join(s: GameSession, req: JoinRequest): Reply {
    const code = normalizeCode(req.code), room = code ? this.rooms.get(code) : undefined;
    if (!room || room.closed) return { ok: false, error: `no room called ${code ?? String(req.code).slice(0, 12).toUpperCase()}` };
    const already = this.bySession.get(s.id);
    if (already?.room === room) return { ok: true, room: room.view(already) };
    if (!this.options.joinablePhases.includes(room.phase)) return { ok: false, error: 'that game has already started' };
    const refused = this.options.canJoin?.(room, s, req);
    if (refused) return { ok: false, error: refused };
    const memberMeta = this.clientMeta(req.memberMeta); if (!memberMeta) return { ok: false, error: 'invalid meta' };
    return this.seat(room, s, req.name, memberMeta);
  }
  private quickPlay(s: GameSession, req: QuickPlayRequest): Reply {
    const mode = typeof req.mode === 'string' ? req.mode : 'default', match = cleanMeta(req.match), memberMeta = this.clientMeta(req.memberMeta);
    if (!match || !memberMeta) return { ok: false, error: 'invalid meta' };
    const current = this.bySession.get(s.id)?.room;
    let best: Room | null = null, bestScore = -1;
    for (const r of this.rooms.values()) {
      if (r.closed || r.visibility !== 'public' || r.mode !== mode || !this.options.quickPlayPhases.includes(r.phase) || !metaMatches(r.meta, match)) continue;
      if (r !== current && !this.hasSeat(r)) continue;
      if (r !== current && this.options.canJoin?.(r, s, req)) continue;
      const score = r.connectedCount * 1e6 + (1e6 - Math.min(1e6 - 1, (Date.now() - r.createdAt) / 1000));
      if (r.connectedCount > 0 || r === current) if (score > bestScore) { best = r; bestScore = score; }
    }
    if (best) {
      const m = this.bySession.get(s.id);
      return best === current && m ? { ok: true, room: best.view(m) } : this.seat(best, s, req.name, memberMeta);
    }
    return this.create(s, { ...(req.create ?? {}), meta: { ...(req.create?.meta ?? {}), ...match }, mode, visibility: 'public', name: req.name, memberMeta });
  }
  private hasSeat(r: Room): boolean {
    return r.members.size < r.maxMembers || this.options.evictDisconnected && [...r.members.values()].some(m => !m.connected);
  }
  private seat(room: Room, s: GameSession, name: unknown, meta: Record<string, Json>): Reply {
    if (room.members.size >= room.maxMembers) {
      const away = [...room.members.values()].filter(m => !m.connected).sort((a, b) => a.disconnectedAt - b.disconnectedAt)[0];
      if (!this.options.evictDisconnected || !away) return { ok: false, error: 'that room is full' };
      this.removeMember(away, 'replaced');
    }
    const old = this.bySession.get(s.id); if (old) this.removeMember(old, 'switched', false);
    const taken = new Set([...room.members.values()].map(m => m.seat));
    let seat = 0; while (taken.has(seat)) seat++;
    const fallback = cleanName((s.hello as Record<string, Json> | null)?.name) || `PLAYER ${seat + 1}`;
    const m: Member = { session: s, room, seat, joinedAt: Date.now(), name: cleanName(name) || fallback, ready: false, connected: s.connected,
      disconnectedAt: 0, meta, data: undefined };
    room.members.set(s.id, m); this.bySession.set(s.id, m); room.emptySince = null;
    if (!room.host || !room.host.connected) this.pickHost(room);
    this.cancelCountdown(room);
    this.safe(() => this.onJoin(room, m));
    this.changed(room, m);
    return { ok: true, room: room.view(m) };
  }
  private pickHost(room: Room) {
    const list = [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    room.host = list.find(m => m.connected) ?? list[0] ?? null;
  }
  private removeMember(m: Member, reason: string, notify = true) {
    const room = m.room;
    if (room.members.get(m.session.id) !== m) return;
    room.members.delete(m.session.id); this.bySession.delete(m.session.id);
    if (notify) this.send(m.session, { [LOBBY_KEY]: 'left', reason });
    if (room.host === m) this.pickHost(room);
    if (!room.members.size) room.emptySince = Date.now();
    this.cancelCountdown(room);
    this.safe(() => this.onLeave(room, m, reason));
    if (reason === 'kicked') this.server.endSession(m.session, 'kicked');
    this.changed(room);
  }
  private setReady(m: Member, ready: boolean) {
    if (!this.options.ready) throw new Error('this game has no ready-up');
    if (m.room.phase !== 'lobby') throw new Error('the game is already running');
    m.ready = ready; if (!ready) this.cancelCountdown(m.room); this.changed(m.room);
  }
  /** @internal Everyone gets the new room view; a ready room starts its countdown. */
  changed(room: Room, skip?: Member) {
    if (room.closed) return;
    for (const m of room.members.values()) if (m !== skip) this.send(m.session, { [LOBBY_KEY]: 'room', room: room.view(m) } as unknown as Json);
    this.checkReady(room);
  }
  private checkReady(room: Room) {
    const r = this.options.ready;
    if (!r || room.phase !== 'lobby' || room.countdownEndsAt !== null) return;
    const live = [...room.members.values()].filter(m => m.connected);
    if (live.length < Math.max(1, r.minMembers ?? 1) || !live.every(m => m.ready)) return;
    const ms = r.countdownMs ?? 3000;
    if (ms <= 0) { this.startRoom(room); return; }
    room.countdownEndsAt = performance.now() + ms;
    room.countdown = setTimeout(() => { room.countdown = undefined; if (room.countdownEndsAt !== null) this.startRoom(room); }, ms);
    for (const m of room.members.values()) this.send(m.session, { [LOBBY_KEY]: 'room', room: room.view(m) } as unknown as Json);
  }
  /** @internal */ cancelCountdown(room: Room) {
    if (room.countdownEndsAt === null) return;
    clearTimeout(room.countdown); room.countdown = undefined; room.countdownEndsAt = null;
    for (const m of room.members.values()) this.send(m.session, { [LOBBY_KEY]: 'room', room: room.view(m) } as unknown as Json);
  }
  /** @internal */ startRoom(room: Room) {
    if (room.closed) return;
    clearTimeout(room.countdown); room.countdown = undefined; room.countdownEndsAt = null;
    room.phase = 'playing'; for (const m of room.members.values()) m.ready = false;
    this.safe(() => this.onStart(room));
    this.changed(room);
  }
  /** @internal */ closeRoom(room: Room, reason: string) {
    if (room.closed) return;
    clearTimeout(room.countdown);
    for (const m of [...room.members.values()]) {
      room.members.delete(m.session.id); this.bySession.delete(m.session.id);
      this.send(m.session, { [LOBBY_KEY]: 'left', reason });
    }
    room.closed = true; this.rooms.delete(room.code);
    this.safe(() => this.onClose(room, reason));
  }
  private sweep() {
    const now = Date.now();
    for (const r of [...this.rooms.values()]) if (!r.members.size && r.emptySince !== null && now - r.emptySince >= this.options.emptyCloseMs) this.closeRoom(r, 'empty');
    for (const [ip, list] of this.creations) if (!list.some(t => now - t < 3600_000)) this.creations.delete(ip);
  }
}
