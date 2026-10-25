# Changelog

## 1.0.0 (2026-10-25)

The first public release. On npm as [`twinwire`](https://www.npmjs.com/package/twinwire).

- **Transport**: one resumable session per player over WebSocket, with a WebRTC data channel (unordered, no
  retransmits) used for state while bidirectional probes prove it; fallback within about 1.5 s and retries with
  backoff; one UDP port per server (ICE mux, node-datachannel). Protocol version 3 (frames start with `TW`).
- **Events**: ordered, acknowledged, deduplicated, replayed after reconnects, mirrored on the datagram path for UDP
  latency; standard JSON semantics; up to 64 KiB each.
- **State**: latest-wins binary streams up to 64 KiB (256 KiB max), priorities and TTLs, a per-peer byte budget that
  lets a burst-sized message through, large states on the WebSocket; optional acknowledgements (`ack: true`,
  `onStateAck`) for delta compression.
- **Lobby**: room codes, quick play by mode and meta (such as a build), seats that survive reconnects and page
  reloads, host hand-off, ready-up with a countdown, kick, eviction of long-gone members from full rooms, setup data
  on create, a client-settable meta allowlist, per-address creation limits.
- **Client**: `whenOnline()`, `transport` and `onTransport`, ICE servers from the server, page lifecycle handling
  (pause after being hidden, a fast liveness check on return, reconnect on `online`), checkpoints, `simulateDrop()`
  for tests.
- **Server**: origin lists or predicates, `trustProxy`, per-connection rate limits, `endSession` (kick), `metrics()`,
  listener hooks, TURN credentials (`turnCredentials` for coturn, `cloudflareTurn`), development-only impairment.
- **Netcode**: `NetworkClock`, `Timeline` and `AdaptivePlayback`, `Predictor`, `InputInbox` and `encodeInputs`,
  `FixedStepper`, `SnapshotHistory` with `diffEntities` and `applyEntityDelta`, `ReplicaSender` and `ReplicaReceiver`,
  `SpatialGrid`, `defineSchema`.
- **Browser bundle**: `twinwire/browser` (`window.Twinwire`, 15 KB gzipped) and an ES module build.
- **Examples**: `examples/party` (a complete small game: lobby, ready-up, prediction, interpolation, chat) and
  `examples/arena` (the transport, with live numbers).
- **Tests**: 89 unit and integration tests; a native WebRTC gate; real Chromium, Firefox and WebKit against the native
  server (clean, impaired, WebSocket only); the party example played in three browsers.
