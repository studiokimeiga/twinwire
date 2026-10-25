import type { RtcCallbacks, RtcPeer, RtcSignal } from '../core/rtc.js';
/** Minimal structural surface used from node-datachannel. The native module is optional and server-only. */
interface NativeChannel {
  isOpen(): boolean; bufferedAmount(): number; sendMessageBinary(b: Buffer): boolean; close(): void;
  onOpen(cb: () => void): void; onClosed(cb: () => void): void;
  onError(cb: (s: string) => void): void; onMessage(cb: (m: string | Buffer) => void): void;
}
interface NativeConnection {
  setRemoteDescription(sdp: string, type: string): void;
  addRemoteCandidate(candidate: string, mid: string): void;
  createDataChannel(label: string, o: Record<string, unknown>): NativeChannel;
  onLocalDescription(cb: (sdp: string, type: string) => void): void;
  onLocalCandidate(cb: (candidate: string, mid: string) => void): void;
  onStateChange(cb: (state: string) => void): void;
  close(): void;
}
interface NativeModule { PeerConnection: new (name: string, options: Record<string, unknown>) => NativeConnection }
export type RtcFactory = (cb: RtcCallbacks) => RtcPeer;
export interface NativeRtcOptions {
  port?: number; publicIp?: string; bindAddress?: string; iceServers?: string[];
  /** Largest datagram accepted or sent, header included (default 64 KiB + 22). Match the endpoints' maxStateBytes. */
  maxMessageSize?: number;
}
/** Load before opening the server. Missing native dependencies fail explicitly, not silently. */
export async function createNativeRtcFactory(options: NativeRtcOptions = {}): Promise<RtcFactory> {
  const name = 'node-datachannel';
  const imported = await import(name) as { default?: NativeModule } & Partial<NativeModule>;
  const native = (imported.default ?? imported) as NativeModule;
  if (typeof native.PeerConnection !== 'function') throw new Error('Unsupported node-datachannel module');
  return nativeRtcFactory(native, options);
}
/** Dependency injection is also used by adapter contract tests. */
export function nativeRtcFactory(native: NativeModule, options: NativeRtcOptions = {}): RtcFactory {
  const port = options.port ?? 8788;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('Invalid UDP port');
  if (options.publicIp && (!/^(\d{1,3}\.){3}\d{1,3}$/.test(options.publicIp) || options.publicIp.split('.').some(n => Number(n) > 255))) throw new Error('publicIp must be an IPv4 address');
  const maxMessage = options.maxMessageSize ?? 64 * 1024 + 22;
  if (!Number.isInteger(maxMessage) || maxMessage < 1100 || maxMessage > 256 * 1024 + 22) throw new RangeError('Invalid maxMessageSize');
  let counter = 0;
  return cb => {
    let alive = true, remote = false, dc: NativeChannel | undefined;
    const pending: Extract<RtcSignal, { kind: 'candidate' }>[] = [];
    const cfg: Record<string, unknown> = { iceServers: options.iceServers ?? [], enableIceUdpMux: true,
      portRangeBegin: port, portRangeEnd: port, maxMessageSize: maxMessage };
    if (options.bindAddress) cfg.bindAddress = options.bindAddress;
    const pc = new native.PeerConnection('twinwire-' + (++counter), cfg);
    const advertised = (s: string) => options.publicIp
      ? s.replace(/(candidate:\S+ \d+ udp \d+ )(\S+)( \d+ typ host)/gi, `$1${options.publicIp}$3`) : s;
    const close = () => { if (!alive) return; alive = false; pending.length = 0; try { dc?.close(); pc.close(); } catch {} };
    pc.onLocalDescription((sdp, type) => { if (alive && type.toLowerCase() === 'answer') cb.signal({ kind: 'answer', sdp: advertised(sdp) }); });
    pc.onLocalCandidate((candidate, mid) => { if (alive) cb.signal({ kind: 'candidate', candidate: advertised(candidate), mid }); });
    pc.onStateChange(state => { if (alive && ['failed', 'closed'].includes(state.toLowerCase())) { close(); cb.closed(); } });
    return {
      close,
      signal(m) {
        if (!alive) return;
        try {
          if (m.kind === 'offer') {
            if (remote) throw new Error('Duplicate RTC offer');
            pc.setRemoteDescription(m.sdp, 'offer'); remote = true;
            dc = pc.createDataChannel('twinwire', { negotiated: true, id: 0, unordered: true, maxRetransmits: 0 });
            const channel = dc;
            channel.onOpen(() => { if (alive) cb.open({
              get open() { return alive && channel.isOpen(); }, get bufferedAmount() { return channel.bufferedAmount(); },
              send: b => {
                if (!alive || !channel.isOpen()) return false;
                // libdatachannel returns false when a connected SCTP send was queued.
                // A nonthrowing call is consumed here; Endpoint enforces the queue limit.
                channel.sendMessageBinary(Buffer.from(b)); return true;
              }, close,
            }); });
            channel.onMessage(m => { if (alive && typeof m !== 'string' && m.length <= maxMessage) cb.data(new Uint8Array(m)); });
            channel.onClosed(() => { if (alive) { close(); cb.closed(); } });
            channel.onError(s => { if (alive) cb.error(new Error(s)); });
            for (const c of pending) pc.addRemoteCandidate(c.candidate, c.mid); pending.length = 0;
          } else if (m.kind === 'candidate') {
            if (remote) pc.addRemoteCandidate(m.candidate, m.mid);
            else { if (pending.length >= 64) throw new Error('Too many RTC candidates'); pending.push(m); }
          }
        } catch (error) { cb.error(error instanceof Error ? error : new Error(String(error))); close(); }
      },
    };
  };
}
