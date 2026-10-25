import type { Json } from './protocol.js';
/** Lobby messages ride on reliable events under this key; the application's own events never use it. */
export const LOBBY_KEY = '$lobby';
export type Visibility = 'public' | 'private';
export interface MemberView {
  seat: number; name: string; ready: boolean; connected: boolean; host: boolean; meta: Record<string, Json>;
}
export interface RoomView {
  code: string; mode: string; visibility: Visibility; phase: string; maxMembers: number;
  meta: Record<string, Json>;
  /** The viewer's own seat. */
  you: number;
  members: MemberView[];
  /** Server clock (ms) when the ready countdown ends, or null. Compare with client.clock.serverTime(). */
  countdownEndsAt: number | null;
}
export interface CreateRequest {
  mode?: string; visibility?: Visibility; maxMembers?: number; meta?: Record<string, Json>; name?: string; memberMeta?: Record<string, Json>;
  /** Anything the game needs to set the room up (a save, a course). Goes to onCreate; never shown to other members. */
  init?: Json;
}
export interface JoinRequest { code: string; name?: string; memberMeta?: Record<string, Json> }
export interface QuickPlayRequest {
  mode?: string;
  /** Only rooms whose meta has these exact values (a build id, a region). */
  match?: Record<string, Json>;
  name?: string; memberMeta?: Record<string, Json>;
  /** Used when no room fits and a new public one is made. */
  create?: Omit<CreateRequest, 'visibility' | 'mode' | 'name' | 'memberMeta'>;
}
/** Readable room codes: no I/O (they look like 1/0). */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export function normalizeCode(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const c = code.trim().toUpperCase();
  return /^[A-Z0-9]{3,12}$/.test(c) ? c : null;
}
const range = (a: number, b: number) => String.fromCharCode(a) + '-' + String.fromCharCode(b);
/** Control, zero-width and bidi-override characters: never allowed in a shown name. */
const INVISIBLE = new RegExp('[' + [range(0, 31), range(127, 159), range(0x200b, 0x200f), range(0x2028, 0x202e), range(0x2066, 0x2069)].join('') + ']', 'g');
export function cleanName(name: unknown, max = 16): string {
  if (typeof name !== 'string') return '';
  return name.replace(/\s+/g, ' ').replace(INVISIBLE, '').replace(/ +/g, ' ').trim().slice(0, max);
}
/** Small flat JSON maps (meta) only: bounded keys, scalar values or short arrays. */
export function cleanMeta(v: unknown, maxBytes = 1024): Record<string, Json> | null {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  let text: string;
  try { text = JSON.stringify(v); } catch { return null; }
  if (text.length > maxBytes) return null;
  const out: Record<string, Json> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[\w.-]{1,32}$/.test(k) || ['__proto__', 'constructor', 'prototype'].includes(k)) return null;
    out[k] = JSON.parse(JSON.stringify(x ?? null)) as Json;
  }
  return out;
}
export function metaMatches(meta: Record<string, Json>, match: Record<string, Json> | undefined): boolean {
  if (!match) return true;
  for (const k of Object.keys(match)) if (JSON.stringify(meta[k] ?? null) !== JSON.stringify(match[k] ?? null)) return false;
  return true;
}
export function isLobbyMessage(d: Json): d is { [LOBBY_KEY]: string } & Record<string, Json> {
  return !!d && typeof d === 'object' && !Array.isArray(d) && typeof (d as Record<string, Json>)[LOBBY_KEY] === 'string';
}
