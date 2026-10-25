import { validSignal, type RtcCallbacks, type RtcPeer, type RtcSignal } from '../core/rtc.js';
/** Browser adapter. Candidates are buffered until the remote description has finished applying. */
export class BrowserRtcPeer implements RtcPeer {
  private pc: RTCPeerConnection;
  private dc: RTCDataChannel;
  private alive = true;
  private offered = false;
  private remoteReady = false;
  private localCandidates: RtcSignal[] = [];
  private remoteCandidates: RTCIceCandidateInit[] = [];
  private chain = Promise.resolve();
  constructor(private cb: RtcCallbacks, config: RTCConfiguration = { iceServers: [] }) {
    this.pc = new RTCPeerConnection(config);
    this.dc = this.pc.createDataChannel('twinwire', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    const pc = this.pc, dc = this.dc; dc.binaryType = 'arraybuffer';
    dc.onopen = () => { if (this.alive) cb.open({
      get open() { return dc.readyState === 'open'; }, get bufferedAmount() { return dc.bufferedAmount; },
      send(bytes) { if (dc.readyState !== 'open') return false; dc.send(bytes.slice().buffer); return true; },
      close: () => this.close(),
    }); };
    dc.onmessage = e => { if (this.alive && e.data instanceof ArrayBuffer) cb.data(new Uint8Array(e.data)); };
    dc.onclose = () => { if (this.alive) { this.close(); cb.closed(); } };
    dc.onerror = () => { if (this.alive) cb.error(new Error('RTC data channel error')); };
    pc.onconnectionstatechange = () => { if (this.alive && pc.connectionState === 'failed') { this.close(); cb.closed(); } };
    pc.onicecandidate = e => {
      if (!this.alive || !e.candidate?.candidate) return;
      const m: RtcSignal = { kind: 'candidate', candidate: e.candidate.candidate, mid: e.candidate.sdpMid ?? '0' };
      if (this.offered) cb.signal(m); else if (this.localCandidates.length < 64) this.localCandidates.push(m);
    };
  }
  async offer(): Promise<void> {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    if (!this.alive) return;
    this.cb.signal({ kind: 'offer', sdp: this.pc.localDescription!.sdp }); this.offered = true;
    for (const c of this.localCandidates) this.cb.signal(c); this.localCandidates = [];
  }
  signal(message: RtcSignal): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (!this.alive || !validSignal(message)) return;
      if (message.kind === 'answer') {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
        if (!this.alive) return;
        this.remoteReady = true;
        for (const c of this.remoteCandidates) await this.pc.addIceCandidate(c);
        this.remoteCandidates = [];
      } else if (message.kind === 'candidate') {
        const c = { candidate: message.candidate, sdpMid: message.mid };
        if (this.remoteReady) await this.pc.addIceCandidate(c);
        else { if (this.remoteCandidates.length >= 64) throw new Error('Too many ICE candidates'); this.remoteCandidates.push(c); }
      }
    }).catch(e => { if (this.alive) this.cb.error(e instanceof Error ? e : new Error(String(e))); });
    return this.chain;
  }
  close(): void {
    if (!this.alive) return; this.alive = false;
    this.localCandidates = []; this.remoteCandidates = [];
    this.dc.onopen = this.dc.onmessage = this.dc.onclose = this.dc.onerror = null;
    this.pc.onicecandidate = this.pc.onconnectionstatechange = null;
    try { this.dc.close(); this.pc.close(); } catch { /* no-op after disposal */ }
  }
}
