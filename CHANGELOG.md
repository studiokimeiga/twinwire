# Changelog

## Unreleased

- **Impairment**: `stallMs` stalls the WebSocket the way a retransmitted TCP segment does: with probability `loss`, a
  send and everything queued behind it waits `stallMs` longer, in order (`stats.impairedStalls`). Without it, `loss`
  still drops datagrams only. This makes a lossy cellular network comparable across the two wires in load tests.

## 1.0.1 (2026-10-25)

Fixes from an independent review and a soak test under hostile clients. No API changes; two new options.

- **Server**: sessions are capped per address (`maxSessionsPerIp`, default `maxPerIp`). Before, one address that kept
  connecting and leaving could fill the whole session table for the resume grace (90 s); now its new session replaces
  its own longest-disconnected one.
- **Events**: events waiting for an earlier one are capped by size too (`events.maxEarlyBytes`, 256 KiB), not only by
  count, so a peer can't park megabytes in that buffer.
- **Lobby**: when everyone had dropped, the host could stay a disconnected member after another came back; the first
  one back now takes it. A member who comes back unready during a ready countdown now cancels it, as a join does,
  instead of being started unready.
- **Handlers that throw**: an exception from `onEvent` on the WebSocket path closed the connection as a protocol error,
  and the client then gave the session up, although API.md promised the event would come again (it did on the datagram
  path). Now, on every path, the event is kept and offered again in order about 100 ms later; an exception from
  `onState` or `onStateAck` is reported and the connection carries on. Both go to `onError` (client) and the server's
  `onError`, counted in `endpoint.stats.eventsRejected` and `callbackErrors`.
- **Delta snapshots**: `diffEntities`/`applyEntityDelta` lost entities whose ids are names every object already has
  (`constructor`, `toString`), and a `__proto__` id from the wire wrote onto `Object.prototype`. Only own properties
  count now, and every id and field name is an ordinary key.
- Tests from an independent review: `test/lobby-lifecycle.test.mjs` and `test/delivery-edges.test.mjs` (111 in all).
- `tools/soak.mjs` (`npm run soak`): a long run under churn and hostile clients that checks for lost events, leaks and stalls.
- Docs: a website (https://studiokimeiga.github.io/twinwire/), and every client, server and lobby option in API.md.

## 1.0.0 (2026-10-25)

The first public release.

- **Transport**: one resumable session per player over WebSocket, with a WebRTC data channel (unordered, no
  retransmits) used for state while bidirectional probes prove it; fallback within ~1.5 s and retries with backoff; one
  UDP port per server (ICE mux, node-datachannel). Protocol version 3 (frames start with `TW`).
- **Events**: ordered, acknowledged, deduplicated, replayed after reconnects, mirrored on the datagram path for UDP
  latency; standard JSON semantics; up to 64 KiB each.
- **State**: latest-wins binary streams up to 64 KiB (256 KiB max), priorities and TTLs, a per-peer byte budget that
  lets a burst-sized message through, large states on the WebSocket; optional acknowledgements (`ack: true`,
  `onStateAck`) for delta compression.
- **Lobby**: room codes, quick play by mode and meta (e.g. build), seats that survive reconnects and page reloads, host
  hand-off, ready-up with a countdown, kick, eviction of long-gone members from full rooms, setup data on create,
  client-settable meta allowlist, per-address creation limits.
- **Client**: `whenOnline()`, `transport`/`onTransport`, ICE servers from the server, page lifecycle handling (pause
  after being hidden, a fast liveness check on return, reconnect on `online`), checkpoints, `simulateDrop()` for tests.
- **Server**: origin lists or predicates, `trustProxy`, per-connection rate limits, `endSession` (kick), `metrics()`,
  listener hooks, TURN credentials (`turnCredentials` for coturn, `cloudflareTurn`), development-only impairment.
- **Netcode**: `NetworkClock`, `Timeline` + `AdaptivePlayback`, `Predictor` + `InputInbox` + `encodeInputs`,
  `FixedStepper`, `SnapshotHistory` + `diffEntities`/`applyEntityDelta`, `ReplicaSender`/`ReplicaReceiver`,
  `SpatialGrid`, `defineSchema`.
- **Browser bundle**: `twinwire/browser` (`window.Twinwire`, 15 KB gzipped) and an ESM build.
- **Examples**: `examples/party` (a complete small game: lobby, ready-up, prediction, interpolation, chat) and
  `examples/arena` (the transport, with live numbers).
- **Tests**: 89 unit and integration tests; a native WebRTC gate; real Chromium, Firefox and WebKit against the native
  server (clean, impaired, WebSocket only); the party example played in three browsers.
