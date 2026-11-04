import type { DatagramLink } from './endpoint.js';
import { VERSION } from './protocol.js';
export interface TransportDuplex { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }
/** Structural adapter boundary, usable with browser WebTransport and optional native providers. */
export interface TransportSession {
  ready?: Promise<unknown>; closed: Promise<unknown>; reliability?: string;
  datagrams: { readable: ReadableStream<Uint8Array>; writable?: WritableStream<Uint8Array>;
    createWritable?: () => WritableStream<Uint8Array>; maxDatagramSize?: number };
  createBidirectionalStream?: () => Promise<TransportDuplex>;
  incomingBidirectionalStreams?: ReadableStream<TransportDuplex>;
  incomingUnidirectionalStreams?: ReadableStream<ReadableStream<Uint8Array>>;
  close(): void;
}
const observedSessions = new WeakSet<TransportSession>(), retiredSessions = new WeakSet<TransportSession>();
/** Peer, endpoint and native host share physical ownership; providers need not tolerate a second close. */
export function observeTransportSession<T extends TransportSession>(session: T): T {
  if (!observedSessions.has(session)) {
    observedSessions.add(session);
    void session.closed.then(() => retiredSessions.add(session), () => retiredSessions.add(session));
  }
  return session;
}
export function closeTransportSession(session: TransportSession): void {
  if (retiredSessions.has(session)) return;
  retiredSessions.add(session);
  try { session.close(); } catch { /* already closed */ }
}
export interface WebTransportOffer { url: string; ticket: string; a: number }
export interface WebTransportBinding {
  open(link: DatagramLink): void; data(bytes: Uint8Array): void; closed(): void; error(error: Error): void;
}
export interface WebTransportClaim { ticket: string; epoch: number; attempt: number; origin?: string }
export interface WebTransportHost {
  readonly url: string;
  setAcceptor(accept: (claim: WebTransportClaim) => WebTransportBinding | null): void;
  close(): Promise<void>;
}
export function deadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('WebTransport handshake timeout')), timeoutMs); });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}
/** One bounded length-prefixed JSON binding frame. QUIC streams do not preserve write/message boundaries. */
export async function readBinding(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const reader = stream.getReader(), buffer = new Uint8Array(4100);
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  let used = 0, length: number | undefined;
  try {
    if (signal?.aborted) throw new Error('WebTransport binding cancelled');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error('Incomplete WebTransport binding');
      if (!(value instanceof Uint8Array) || value.length > buffer.length - used) throw new Error('WebTransport binding limit');
      buffer.set(value, used); used += value.length;
      if (used >= 4 && length === undefined) {
        length = new DataView(buffer.buffer).getUint32(0);
        if (length < 2 || length > 4096) throw new Error('WebTransport binding limit');
      }
      if (length !== undefined && used >= length + 4) {
        if (used !== length + 4) throw new Error('Trailing WebTransport binding bytes');
        const tail = await reader.read();
        if (!tail.done) throw new Error('Trailing WebTransport binding bytes');
        let value: unknown;
        try { value = JSON.parse(new TextDecoder().decode(buffer.subarray(4, used))); }
        catch { throw new Error('Invalid WebTransport binding'); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid WebTransport binding');
        return value as Record<string, unknown>;
      }
    }
  } finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
}
export async function writeBinding(stream: WritableStream<Uint8Array>, message: unknown, signal?: AbortSignal): Promise<void> {
  const text = new TextEncoder().encode(JSON.stringify(message));
  if (text.length > 4096) throw new Error('WebTransport binding limit');
  const frame = new Uint8Array(text.length + 4); new DataView(frame.buffer).setUint32(0, text.length); frame.set(text, 4);
  const writer = stream.getWriter();
  const abort = () => { void writer.abort().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('WebTransport binding cancelled');
    await writer.write(frame); await writer.close();
  } finally { signal?.removeEventListener('abort', abort); writer.releaseLock(); }
}
export function validOffer(value: unknown): value is WebTransportOffer {
  if (!value || typeof value !== 'object') return false;
  const v = value as WebTransportOffer;
  try { const u = new URL(v.url); return u.protocol === 'https:' && !u.username && !u.password && !u.hash &&
    /^[\w-]{32,128}$/.test(v.ticket) && Number.isSafeInteger(v.a) && v.a > 0; }
  catch { return false; }
}
/** Each pending write is counted; queue growth is bounded even when the provider's writer stalls. */
export function datagramConnection(session: TransportSession, maxMessageBytes: number, callbacks: WebTransportBinding,
  maxBufferedBytes = 64 * 1024): DatagramLink {
  observeTransportSession(session);
  const writable = session.datagrams.writable ?? session.datagrams.createWritable?.();
  if (!writable) throw new Error('No WebTransport datagram writer');
  const writer = writable.getWriter(), reader = session.datagrams.readable.getReader();
  let alive = true, buffered = 0;
  // Releasing a pending read rejects it without closing the provider-owned controller.
  // Some native providers close those controllers themselves during physical session teardown.
  const releaseReaders: (() => void)[] = [() => reader.releaseLock()];
  const limit = () => {
    const current = session.datagrams.maxDatagramSize;
    return typeof current === 'number' && Number.isSafeInteger(current) && current >= 0 ? Math.min(maxMessageBytes, current) : maxMessageBytes;
  };
  const close = () => {
    if (!alive) return; alive = false;
    for (const release of releaseReaders) release();
    void writer.abort().catch(() => {}).finally(() => writer.releaseLock());
    closeTransportSession(session);
  };
  const failure = () => { if (alive) { close(); callbacks.closed(); } };
  void session.closed.then(failure, failure);
  // This adapter uses exactly one reliable binding stream, never unbounded incoming resource streams.
  const rejectStreams = <T>(streams: ReadableStream<T> | undefined, reject: (value: T) => void) => {
    if (!streams) return;
    const incoming = streams.getReader();
    releaseReaders.push(() => incoming.releaseLock());
    void (async () => {
      let count = 0;
      try {
        while (alive) {
          const { done, value } = await incoming.read(); if (done) break;
          reject(value); if (++count > 8) { failure(); break; }
        }
      } catch { failure(); } finally { incoming.releaseLock(); }
    })();
  };
  rejectStreams(session.incomingBidirectionalStreams, stream => {
    void stream.readable.cancel().catch(() => {}); void stream.writable.abort().catch(() => {});
  });
  rejectStreams(session.incomingUnidirectionalStreams, stream => { void stream.cancel().catch(() => {}); });
  const link: DatagramLink = {
    get open() { return alive; }, get bufferedAmount() { return buffered; }, get maxMessageBytes() { return limit(); },
    send(bytes) {
      if (!alive || bytes.length > limit() || buffered + bytes.length > maxBufferedBytes) return false;
      buffered += bytes.length;
      void writer.write(bytes.slice()).then(() => { buffered -= bytes.length; }, () => { buffered -= bytes.length; failure(); });
      return true;
    }, close,
  };
  void (async () => {
    try {
      while (alive) {
        const { done, value } = await reader.read(); if (done) { failure(); break; }
        if (!alive) break;
        if (!(value instanceof Uint8Array) || value.length > maxMessageBytes) throw new Error('WebTransport datagram limit');
        callbacks.data(value);
      }
    } catch { failure(); } finally { reader.releaseLock(); }
  })();
  return link;
}
export const bindingVersion = VERSION;
