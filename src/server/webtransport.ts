import { randomBytes } from 'node:crypto';
import { bindingVersion, datagramConnection, deadline, readBinding, writeBinding, observeTransportSession, closeTransportSession,
  type TransportSession, type WebTransportBinding, type WebTransportClaim, type WebTransportHost } from '../core/webtransport.js';
export type { WebTransportHost, WebTransportClaim, WebTransportBinding, TransportSession } from '../core/webtransport.js';
/** Host-adapter entry point. An accepted HTTP/3 session still needs a one-use, live WebSocket binding ticket. */
export async function acceptWebTransport(session: TransportSession, claim: (request: WebTransportClaim) => WebTransportBinding | null,
  options: { origin?: string; maxDatagramSize?: number; handshakeTimeoutMs?: number; unreliableDatagrams?: boolean } = {}): Promise<void> {
  observeTransportSession(session);
  const abort = new AbortController();
  void session.closed.then(() => abort.abort(), () => abort.abort());
  try {
    await deadline((async () => {
      if (options.unreliableDatagrams !== true) throw new Error('Host must verify unreliable transport support');
      if (!session.incomingBidirectionalStreams) throw new Error('Missing binding stream');
      const incoming = session.incomingBidirectionalStreams.getReader();
      const abortIncoming = () => incoming.releaseLock();
      abort.signal.addEventListener('abort', abortIncoming, { once: true });
      if (abort.signal.aborted) abortIncoming();
      let stream;
      try { const result = await incoming.read(); if (result.done) throw new Error('Missing binding stream'); stream = result.value; }
      finally { abort.signal.removeEventListener('abort', abortIncoming); incoming.releaseLock(); }
      const hello = await readBinding(stream.readable, abort.signal);
      if (abort.signal.aborted || hello.v !== bindingVersion || !Number.isInteger(hello.e) || (hello.e as number) < 1 || (hello.e as number) > 65535 ||
          !Number.isSafeInteger(hello.a) || (hello.a as number) < 1 ||
          typeof hello.ticket !== 'string' || !/^[\w-]{32,128}$/.test(hello.ticket) ||
          !Number.isSafeInteger(hello.maxDatagramSize) || (hello.maxDatagramSize as number) < 1024)
        throw new Error('Invalid binding');
      const binding = claim({ ticket: hello.ticket, epoch: hello.e as number, attempt: hello.a as number, origin: options.origin });
      if (!binding) throw new Error('Binding rejected');
      const max = Math.min(options.maxDatagramSize ?? 1100, hello.maxDatagramSize as number);
      if (!Number.isSafeInteger(max) || max < 1024 || max > 65535) throw new Error('Invalid datagram limit');
      await writeBinding(stream.writable, { ok: true, unreliableDatagrams: true, maxDatagramSize: max }, abort.signal);
      if (abort.signal.aborted) throw new Error('Retired WebTransport binding');
      binding.open(datagramConnection(session, max, binding));
    })(), options.handshakeTimeoutMs ?? 5000);
  } catch { abort.abort(); closeTransportSession(session); }
}
export interface WebTransportHostOptions {
  url: string; cert: string; privKey: string; port?: number; host?: string;
  maxConnections?: number; maxDatagramSize?: number; handshakeTimeoutMs?: number;
}
/** Optional Node HTTP/3 provider. Fails clearly when the native addon cannot load; RTC/WS need neither package. */
export async function createWebTransportHost(options: WebTransportHostOptions): Promise<WebTransportHost> {
  const url = new URL(options.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid WebTransport URL');
  const nativeName = '@fails-components/webtransport-transport-http3-quiche', providerName = '@fails-components/webtransport';
  // Direct preflight: the provider currently catches native load errors in its own readiness promise.
  await import(nativeName);
  const provider = await import(providerName);
  const server = new provider.Http3Server({ port: options.port ?? Number(url.port || 443), host: options.host ?? '0.0.0.0',
    cert: options.cert, privKey: options.privKey, secret: randomBytes(32).toString('hex') });
  let accept: ((claim: WebTransportClaim) => WebTransportBinding | null) | undefined, stopped = false;
  const sessions = new Set<TransportSession>();
  const stream = server.sessionStream(url.pathname).getReader();
  server.startServer();
  try { await deadline(server.ready, 5000); } catch (error) { try { server.stopServer(); } catch {} throw error; }
  if (options.port === 0 || url.port === '0') url.port = String(server.address().port);
  void (async () => {
    try {
      while (!stopped) {
        const result = await stream.read(); if (result.done) break;
        const session = observeTransportSession(result.value as TransportSession & { header?: Record<string, string> });
        if (!accept || sessions.size >= (options.maxConnections ?? 256)) { closeTransportSession(session); continue; }
        sessions.add(session);
        void session.closed.then(() => sessions.delete(session), () => sessions.delete(session));
        void acceptWebTransport(session, accept, { origin: session.header?.origin, maxDatagramSize: options.maxDatagramSize,
          handshakeTimeoutMs: options.handshakeTimeoutMs, unreliableDatagrams: true });
      }
    } catch { if (!stopped) for (const session of sessions) closeTransportSession(session); }
  })();
  return { get url() { return url.href; }, setAcceptor(fn) { if (accept) throw new Error('WebTransport host already attached'); accept = fn; },
    async close() {
      if (stopped) return; stopped = true;
      for (const session of sessions) closeTransportSession(session); sessions.clear();
      await stream.cancel().catch(() => {}); stream.releaseLock(); server.stopServer();
    } };
}
