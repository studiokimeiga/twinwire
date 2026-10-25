import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRtcFactory } from '../dist/server/rtc.js';
import { BrowserRtcPeer } from '../dist/client/rtc.js';
import { validSignal } from '../dist/core/rtc.js';
import { encodeInputs, decodeInputs } from '../dist/netcode/inputs.js';
import { pair } from './helpers.mjs';
test('native adapter uses one UDP port, no retransmits and verifies fingerprints by default', () => {
  let config, channelConfig, remote, delivered, opened, peer, dc;
  class Connection {
    constructor(name, c) { config = c; peer = this; }
    onLocalDescription(cb) { this.description = cb; } onLocalCandidate(cb) { this.candidate = cb; }
    onStateChange(cb) { this.state = cb; } setRemoteDescription(sdp, type) { remote = { sdp, type }; }
    addRemoteCandidate() {} close() {}
    createDataChannel(label, c) {
      channelConfig = c; dc = { isOpen: () => true, bufferedAmount: () => 0, sendMessageBinary: () => true, close() {},
        onOpen(cb) { this.open = cb; }, onClosed(cb) { this.closed = cb; }, onError(cb) { this.error = cb; }, onMessage(cb) { this.message = cb; } }; return dc;
    }
  }
  const signals = [];
  const create = nativeRtcFactory({ PeerConnection: Connection }, { port: 8788, publicIp: '203.0.113.7' });
  const handle = create({ signal: s => signals.push(s), open: link => opened = link, data: d => delivered = d, error: e => { throw e; }, closed() {} });
  handle.signal({ kind: 'offer', sdp: 'offer' });
  assert.equal(config.enableIceUdpMux, true); assert.equal(config.portRangeBegin, 8788); assert.equal(config.portRangeEnd, 8788);
  assert.equal(config.disableFingerprintVerification, undefined); assert.equal(channelConfig.maxRetransmits, 0); assert.equal(channelConfig.unordered, true);
  assert.equal(remote.type, 'offer'); dc.open(); assert.ok(opened.open); dc.message(Buffer.from([4])); assert.equal(delivered[0], 4);
  peer.candidate('candidate:1 1 udp 10 10.0.0.2 8788 typ host', '0'); assert.ok(signals[0].candidate.includes('203.0.113.7'));
  dc.sendMessageBinary = () => false;
  assert.equal(opened.send(Uint8Array.of(5)), true, 'a queued native send is consumed, not sent a second time');
  handle.close(); assert.equal(opened.open, false);
});
test('browser adapter sends the offer before locally gathered candidates', async () => {
  const Old = globalThis.RTCPeerConnection; let pc;
  class Fake {
    constructor() { pc = this; this.remoteDescription = null; }
    createDataChannel() { return { close() {}, readyState: 'connecting' }; }
    async createOffer() { return { type: 'offer', sdp: 'offer' }; }
    async setLocalDescription(d) { this.localDescription = d; this.onicecandidate({ candidate: { candidate: 'ice', sdpMid: '0' } }); }
    async setRemoteDescription(d) { await Promise.resolve(); this.remoteDescription = d; }
    async addIceCandidate(c) { assert.ok(this.remoteDescription, 'description completed before candidate'); this.added = c; }
    close() {}
  }
  globalThis.RTCPeerConnection = Fake;
  const signals = [], errors = [];
  try {
    const peer = new BrowserRtcPeer({ signal: s => signals.push(s), open() {}, data() {}, closed() {}, error: e => errors.push(e) });
    await peer.offer(); assert.equal(signals[0].kind, 'offer'); assert.equal(signals[1].kind, 'candidate');
    await peer.signal({ kind: 'candidate', candidate: 'remote candidate', mid: '0' });
    await peer.signal({ kind: 'answer', sdp: 'answer' }); assert.equal(pc.added.candidate, 'remote candidate'); assert.equal(errors.length, 0);
    peer.close();
  } finally { globalThis.RTCPeerConnection = Old; }
});
test('invalid signaling values are rejected', () => {
  for (const value of [null, [], {}, { kind: 'candidate', candidate: 1, mid: '0' }, { kind: 'offer', sdp: 'x'.repeat(13000) }]) assert.equal(validSignal(value), false);
});
test('redundancy bundles fit a state frame and malformed lengths cannot escape decoding', () => {
  const input = [{ seq: 1, data: Uint8Array.of(1, 2) }, { seq: 2, data: Uint8Array.of(3, 4) }];
  const b = encodeInputs(input); assert.deepEqual(decodeInputs(b), input);
  for (let n = 0; n < b.length; n++) assert.equal(decodeInputs(b.subarray(0, n)), null);
  assert.throws(() => encodeInputs([...input, input[0]]));
});
test('acknowledgement blocked by backpressure is retried after the queue drains', () => {
  const p = pair(); let calls = 0; p.b.onEvent = () => calls++; p.blocked.bufferedB = 100000;
  p.a.sendEvent('event'); p.deliver(); assert.equal(calls, 1); assert.equal(p.a.events.size, 1);
  p.blocked.bufferedB = 0; p.advance(); assert.equal(p.a.events.size, 0); assert.equal(calls, 1);
});
