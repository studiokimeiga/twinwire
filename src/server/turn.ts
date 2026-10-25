import { createHmac } from 'node:crypto';
import { validIceServers, type IceServer } from '../core/rtc.js';
/**
 * Short-lived TURN credentials for coturn's `use-auth-secret` (the "TURN REST API" scheme): the username is
 * `<expiry unix seconds>:<user>` and the password is base64(HMAC-SHA1(secret, username)). Never ship the secret.
 */
export function turnCredentials(o: { secret: string; urls: string | string[]; user?: string; ttlSeconds?: number; now?: number }): IceServer {
  if (!o.secret) throw new Error('TURN secret required');
  const ttl = o.ttlSeconds ?? 3600;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 7 * 86400) throw new RangeError('Invalid TURN ttl');
  const user = (o.user ?? 'player').replace(/[^\w.-]/g, '').slice(0, 64) || 'player';
  const username = `${Math.floor((o.now ?? Date.now()) / 1000) + ttl}:${user}`;
  const server = { urls: o.urls, username, credential: createHmac('sha1', o.secret).update(username).digest('base64') };
  if (!validIceServers([server])) throw new Error('Invalid TURN URL');
  return server;
}
/**
 * ICE servers from Cloudflare Realtime TURN (a managed relay with anycast TURN over UDP, TCP and TLS:443).
 * Credentials are fetched with your key and cached until shortly before they expire.
 */
export function cloudflareTurn(o: { keyId: string; apiToken: string; ttlSeconds?: number; fetch?: typeof fetch }): () => Promise<IceServer[]> {
  const ttl = o.ttlSeconds ?? 86400, get = o.fetch ?? fetch;
  let cached: IceServer[] | null = null, until = 0, inflight: Promise<IceServer[]> | null = null;
  return async () => {
    if (cached && Date.now() < until) return cached;
    inflight ??= (async () => {
      try {
        const res = await get(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(o.keyId)}/credentials/generate-ice-servers`, {
          method: 'POST', headers: { Authorization: `Bearer ${o.apiToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl }),
        });
        if (!res.ok) throw new Error(`Cloudflare TURN ${res.status}`);
        const body = await res.json() as { iceServers?: unknown };
        const list = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : [];
        if (!validIceServers(list)) throw new Error('Cloudflare TURN returned invalid ICE servers');
        cached = list; until = Date.now() + ttl * 900; return list;
      } finally { inflight = null; }
    })();
    return inflight;
  };
}
