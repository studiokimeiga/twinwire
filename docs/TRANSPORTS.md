# Transport, latency and resource controls (3.0 candidate)

3.0 uses wire generation **5**. Deploy matching clients and servers together; a 2.x client is not compatible with a
3.0 server. Preserve the previous paired release for rollback. Existing game APIs remain usable, but code that
matches a transport name must now handle `wt` alongside `rtc`, `ws` and `none`.

## Observe the actual boundaries

```js
import { GameClient, StateTraceBuffer } from 'twinwire/client';
const trace = new StateTraceBuffer(1024);
const client = new GameClient({url, room, endpoint: {trace: event => trace.record(event)}});
const receiver = client.receiveState({stream: 1, apply, reset, playback});
// In the render loop, after sampling your timeline and submitting its view:
const at = receiver.advance(dtMs);
if (at !== null) {
  render(at);
  receiver.markRendered(at);
}
console.log(trace.summary());
```

The optional recorder retains bounded metadata for enqueue, send, receive, successful application, playback cursor
and explicit render-submission marks. Queue delay is local. Snapshot age uses the synchronized server-clock
estimate and includes its uncertainty. Receipt means JavaScript received the message, not that a packet just hit
the network interface. Render submission is not GPU presentation. These distinctions prevent attributing every
browser stall or interpolation delay to the transport. No payloads or credentials are recorded. Keep expensive
logging outside callbacks; observer exceptions are counted without stopping delivery.

## Optional WebTransport fast path

Install both optional server peers on a platform supported by their native HTTP/3 binary:

```sh
npm install @fails-components/webtransport@1.6.11 @fails-components/webtransport-transport-http3-quiche@1.6.11
```

```js
import {createGameServer, createWebTransportHost} from 'twinwire/server';
const webtransport = await createWebTransportHost({
  url: 'https://play.example.com:9443/twinwire', port: 9443,
  cert: certificatePem, privKey: privateKeyPem,
});
const server = await createGameServer({origins: ['https://game.example.com'], webtransport, rtc});
await server.listen();
```

Use a publicly trusted certificate, route UDP to the HTTP/3 listener and manage renewal. Normal HTTP reverse
proxying does not provide a WebTransport listener. A configured native host fails clearly if its provider cannot
load; omit it on unsupported hosts to keep the existing RTC/WS deployment. The current prebuilt Linux binary
requires glibc 2.38, so Ubuntu 22.04 needs a supported host/provider build. Native dependencies never enter browser
or Worker bundles. The HTTP/3 provider is optional and independent of Twinwire's default `ws` dependency.

Browsers establish the WebSocket session immediately. If WebTransport is offered and natively supported, a short,
length-prefixed reliable binding stream authenticates it with a one-use, time-limited ticket issued on that live
WebSocket. Tickets never appear in URLs. Both peers independently probe datagrams; connection readiness alone is
insufficient. Reliable-only/unknown capabilities keep RTC/WS. An old epoch, consumed ticket or retired attempt
cannot attach to a new connection.

The endpoint can retain proven RTC and WT paths, sending state on one. RTT margin and hold-time hysteresis avoid
oscillating between comparable routes (`preferredDatagram`, `pathSwitchMarginMs`, `pathSwitchHoldMs`). This policy
uses measured probe RTT, not a claim that RTT is one-way delay or that QUIC is universally faster. Compare actual
state age and loss in your application. `endpoint.datagramPaths` reports current proof and payload capabilities.
Reliable gameplay events and session control still use WebSocket, with event copies on the selected fast path.

RTC messages can be SCTP-fragmented. QUIC datagrams cannot reuse that assumption: complete frames must fit the
negotiated datagram size. Larger states use WS. `webtransport: false` disables browser attempts. Development-only
short-lived certificate hashes can be supplied in client options; production uses normal certificate validation.

## Bulk resources use independent HTTP requests

```js
import {BulkClient} from 'twinwire/client';
const resources = new BulkClient({concurrency: 2, maxQueued: 16, maxBytes: 8 * 1024 * 1024});
const transfer = resources.request('/resources/region_123', {sha256: expectedHash});
const bytes = await transfer.promise;
// transfer.cancel(); resources.close();
```

HTTP transport is available across browsers without WebTransport. Resources do not consume event sequence numbers,
wait behind a missing gameplay event, or allocate permanent state stream IDs. Requests bound concurrency, queue
length and reserved download memory; response length is checked both in headers and while streaming. SHA-256
verification is optional and requires a secure browser context. Assembly may temporarily use twice the reserved
download buffer; completed resources belong to the game and need its own cache/eviction policy.

Node hosts can attach `createBulkHandler({origins, authorize, resolve})` to their HTTP hook. The returned async
handler returns false for unrelated routes. It accepts opaque IDs under `/resources/`, caps simultaneous responses
and resource size, honors client cancellation/backpressure and supplies content hashes as ETags. It never maps IDs
to filesystem paths. Authorization, chunk generation, versions and world revisions belong to the application.
Respect the resolver's AbortSignal, and configure HTTP/proxy timeouts and bandwidth alongside the game's budget.
HTTP/2 can still share TCP congestion across resource requests; isolation from the gameplay event sequence does
not eliminate physical bandwidth contention.

## Mixed-load scheduling

State and ordered events receive protected shares of the configured application byte budget (default 50/50 when
both are busy). Idle positive credit can be borrowed, so pure-state/pure-event traffic can use the full rate. Large
event debt stays in its class; failed writes refund reservations. State still coalesces, expires and uses priority
plus waiting age. A large unsendable candidate does not hide smaller useful updates. Configure `stateBudgetShare`
between zero and one to match the workload, and measure the effect on event delay as well as snapshot delivery.
An oversized message can spend future credit, as in previous releases. Control/probes and fast event mirrors keep
their existing exemptions; this is an application budget, not an exact IP/TLS billing cap or a replacement for
congestion control.

## Candidate verification

`node tools/compare-transport.mjs --baseline /path/to/extracted/2.3.0/package` produces a deterministic endpoint
comparison, explicitly separate from real-network measurements. `node tools/webtransport-e2e.mjs` requires the
native HTTP/3 provider and browsers; it asserts actual WT application states where supported, then RTC/WS fallback,
position/render recovery and one queued action after resuming the same session. Unsupported browser APIs are
reported as fallback coverage, never labeled QUIC. `IMPAIR=1` adds application-level datagram loss/delay; this does
not emulate QUIC's complete network congestion behavior. Release receipts must record what actually ran.
