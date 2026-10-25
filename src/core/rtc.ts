import type { DatagramLink } from './endpoint.js';
export type RtcSignal = { kind: 'offer' | 'answer'; sdp: string } | { kind: 'candidate'; candidate: string; mid: string };
export interface RtcCallbacks {
  signal: (message: RtcSignal) => void;
  open: (link: DatagramLink) => void;
  data: (bytes: Uint8Array) => void;
  closed: () => void;
  error: (error: Error) => void;
}
export interface RtcPeer { signal(message: RtcSignal): void | Promise<void>; close(): void }
/** The browser's RTCIceServer shape: STUN, or TURN with credentials. */
export interface IceServer { urls: string | string[]; username?: string; credential?: string }
export function validSignal(m: unknown): m is RtcSignal {
  if (!m || typeof m !== 'object') return false;
  const v = m as Record<string, unknown>;
  if (v.kind === 'offer' || v.kind === 'answer') return typeof v.sdp === 'string' && v.sdp.length > 0 && v.sdp.length <= 12000;
  return v.kind === 'candidate' && typeof v.candidate === 'string' && v.candidate.length <= 1500 &&
    typeof v.mid === 'string' && v.mid.length <= 128;
}
const ICE_URL = /^(stuns?|turns?):[^\s]{1,250}$/;
export function validIceServers(v: unknown): v is IceServer[] {
  return Array.isArray(v) && v.length <= 8 && v.every(s => {
    if (!s || typeof s !== 'object') return false;
    const o = s as Record<string, unknown>, urls = Array.isArray(o.urls) ? o.urls : [o.urls];
    return urls.length >= 1 && urls.length <= 8 && urls.every(u => typeof u === 'string' && ICE_URL.test(u)) &&
      (o.username === undefined || typeof o.username === 'string' && o.username.length <= 256) &&
      (o.credential === undefined || typeof o.credential === 'string' && o.credential.length <= 256);
  });
}
