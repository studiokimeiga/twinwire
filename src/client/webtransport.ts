import { bindingVersion, datagramConnection, deadline, readBinding, writeBinding,
  type TransportSession, type WebTransportBinding, type WebTransportOffer } from '../core/webtransport.js';
export interface BrowserWebTransportOptions {
  /** Override with a standards-compatible provider; absent native support simply retains RTC/WS. */
  create?: (url: string, options: Record<string, unknown>) => TransportSession;
  /** Certificate hashes are for short-lived development certificates. Production normally uses public TLS trust. */
  serverCertificateHashes?: { algorithm: string; value: BufferSource }[];
  connectTimeoutMs?: number; retryMs?: number;
}
export class BrowserWebTransportPeer {
  private session?: TransportSession;
  private alive = true;
  private abort = new AbortController();
  constructor(private readonly callbacks: WebTransportBinding) {}
  static supported(options: BrowserWebTransportOptions): boolean {
    return !!options.create || typeof (globalThis as unknown as { WebTransport?: unknown }).WebTransport === 'function';
  }
  async connect(offer: WebTransportOffer, epoch: number, options: BrowserWebTransportOptions): Promise<void> {
    try {
      const native = (globalThis as unknown as { WebTransport?: new (url: string, options: Record<string, unknown>) => TransportSession }).WebTransport;
      const create = options.create ?? ((url, opts) => new native!(url, opts));
      const session = this.session = create(offer.url, { requireUnreliable: true, congestionControl: 'low-latency',
        ...(options.serverCertificateHashes ? { serverCertificateHashes: options.serverCertificateHashes } : {}) });
      void session.closed.then(() => this.abort.abort(), () => this.abort.abort());
      await deadline((async () => {
        await session.ready;
        if (!this.alive) return;
        if (session.reliability !== 'supports-unreliable') throw new Error('WebTransport does not prove unreliable support');
        const size = session.datagrams.maxDatagramSize;
        if (!Number.isSafeInteger(size) || size! < 1024 || !session.createBidirectionalStream) throw new Error('WebTransport capabilities unavailable');
        const stream = await session.createBidirectionalStream();
        await writeBinding(stream.writable, { v: bindingVersion, e: epoch, a: offer.a, ticket: offer.ticket, maxDatagramSize: size }, this.abort.signal);
        const reply = await readBinding(stream.readable, this.abort.signal);
        if (reply.ok !== true || !Number.isSafeInteger(reply.maxDatagramSize) || (reply.maxDatagramSize as number) < 1024 || (reply.maxDatagramSize as number) > size!)
          throw new Error('WebTransport binding rejected');
        if (!this.alive) return;
        const link = datagramConnection(session, reply.maxDatagramSize as number, this.callbacks);
        if (this.alive) this.callbacks.open(link); else link.close();
      })(), options.connectTimeoutMs ?? 5000);
    } catch {
      if (this.alive) { this.close(); this.callbacks.closed(); }
    }
  }
  close(): void {
    if (!this.alive) return; this.alive = false;
    this.abort.abort();
    try { this.session?.close(); } catch { /* already closed */ }
  }
}
