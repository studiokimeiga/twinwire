# Changelog

## Unreleased

- A handler that keeps throwing can no longer stall a player's events or end the session. A rejected event is now
  offered at most `events.maxRejections` times (default 10, about a second), then dropped and acknowledged, so the
  events behind it continue in order. If the queue behind it fills first, it is dropped at once instead of the session
  being closed with `Event sequence gap`. `stats.eventsDropped` counts these and `onError` reports each one. This
  changes the previous "offered until accepted" behavior: a handler that throws to wait for something slower than a
  second should set `maxRejections: Infinity`, which keeps the old behavior, including session loss on a full queue.
- Extra copies of a rejected event, such as its datagram mirror, wait for the 100 ms retry delay and no longer count
  as attempts.
- Wire generation 5 is unchanged. The change is local to the receiving end, so either side can upgrade first.

## 3.0.1 (2026-11-04)

- Fix sustained underuse of the event byte share when reliable events exceed the burst. Repay bounded one-packet
  debt before the next oversized event instead of repeatedly waiting for a full bucket and clipping pump overshoot.
  Preserve state scheduling, ordered replay, protected credit, rejected-write refunds and the configured byte rate.
- Add minute-long real-browser state-age and reliable-throughput gates against the unchanged published 2.3 baseline.
  With an explicit throughput-oriented state share of 0.075, five alternating pairs per browser/path deliver lower
  p95 draw-submission state age and at least as many reliable events in every pair. The default remains 0.5; this
  balanced setting does not retain the earlier default-share 66% age benefit. See validation/RELIABLE_PARITY.md.
- Wire generation 5 and the application APIs are unchanged. This patch is compatible with 3.0.0 peers. Actual-game
  rendering measurements are separate from the transport comparison; no general game-FPS increase is promised.

## 3.0.0 (2026-11-04)

- Wire generation 5 adds optional authenticated WebTransport datagrams. Bind each physical HTTP/3 path to the live
  WebSocket session using a short-lived, one-use ticket and epoch; prove both directions before selecting it. Keep
  independently proven RTC and WS fallback, path-size limits and hysteresis. Reliable session/events remain on WS.
  Respect changing datagram limits and provider-owned stream teardown; standby proof clears retry debt too.
  This protocol change requires paired client/server deployment; 2.x clients cannot connect to 3.0 hosts.
- Add optional bounded metadata tracing for state enqueue, send, receipt, accepted application, playback and explicit
  render submission. Report clock uncertainty and separate queue time from playback age; never retain payloads/secrets.
- Add bounded cancellable HTTP bulk resources with browser admission/memory limits, optional SHA-256 integrity and a
  Node handler with authorization, origin checks, ETags and backpressure. Bulk bytes stay outside ordered game events.
  Stalled downloads time out, older AbortSignals work, malformed targets return400 and source buffers are snapshotted.
- Protect state and reliable-event bandwidth under mixed load while lending surplus positive credit. Refund failed
  writes and allow useful smaller states past unsendable large candidates. Preserve ordered event delivery.
- Add regressions, deterministic comparison with published 2.3.0 and hosted real QUIC/browser and alternating-process
  localhost benchmark gates. Candidate/release evidence is recorded in validation/STATUS.md; no universal speedup claim.
- Fix mutable Node Buffer views at state/frame/replica ownership boundaries: later caller mutations cannot change
  an already queued or decoded snapshot. Require patched ws8.22+ and patch the pinned local Worker tool's dependencies.

## 2.3.0 (2026-11-01)

- The server now measures each client's round trip itself: every `probeMs` (2000 by default, 0 turns it off) it sends a small probe that clients echo at once, and keeps a smoothed `session.rttMs` and the connection's `session.minRttMs`. This is the independent observation `selectRewindTime` asks for: expect a shooter's view half the round trip, its playback delay (which already includes the other half), a frame and its input-queue wait behind `now` (docs/ADOPTING.md has the model and a calibration). Both hosts (Node and Worker) probe; clients before this release never answer and leave `rttMs` null, so keep a fallback. Measurements restart on each connection. Wire protocol 4 is unchanged: a 2.2 client ignores probes, and a 2.2 server never sends them.
- Tests build and pass on Windows: a worker-bundle path no longer goes through `URL.pathname`, and the 128 Hz pump test drives its game loop by elapsed time, stating that a Windows host's coarse timers cannot run a 128 Hz pump (`flush()` per tick still carries every state).

- Restore Safari 15.0–15.3 compatibility for default clones across sub-tick capture/replay, prediction, interpolation, input inboxes and reliable-event checkpoints. Use native `structuredClone` where available; otherwise clone common structured input data without JSON serialization loss, with explicit failure for unsupported objects. Add missing-native browser and regression coverage; protocol and dependencies are unchanged.

- Add optional `SubtickInputBuffer` and `replaySubtick` netcode helpers: capture monotonic client input edges into fixed-tick fractions and replay segments deterministically without changing simulation tick rate or the wire protocol. Queue bounds, skipped windows, nonmonotonic times and invalid fractions fail explicitly.
- Add `selectRewindTime` for Source-style server-derived rewind-time validation. It falls back to an independently estimated server time for implausible client requests only while that estimate is within history. Otherwise it returns `timeMs: null` and requires explicit game policy; game authority and hit verification remain application responsibilities.
- Add dedicated edge/boundary/overflow/forged-time regressions and documentation. Freeze replay scheduling and clone input values before invoking game callbacks; reject reentrant input cloning and arithmetic overflow in derived history bounds. Existing transports, games and API defaults are unchanged.

Release validation is recorded in validation/STATUS.md.


## 2.2.0 (2026-10-26)

- The Worker host explicitly selects ArrayBuffer binary delivery and completes close handshakes on older runtimes. Real workerd regressions failed under the modern Blob default and the older manual-close behavior before this fix; both compatibility dates are release gates.

- A closing browser socket now holds playback and reports recovery promptly. Heartbeat/handshake timeouts retire and generation-fence the old socket before retrying, so an offline close handshake cannot keep the client apparently online or suppress a resume. Late callbacks from the retired socket cannot end the new connection. A real-socket fault regression failed before this fix.

- Added named EventClient/createEventServer helpers for migrating existing games. Configured names are independent latest-wins JSON streams with recovery gates; other names are acknowledged events. Handlers, player identity and room membership survive a physical reconnect. Pauses and terminal session expiry have distinct callbacks.
- Added twinwire/worker, a standard-WebSocket SocketSessionServer for a long-lived Worker or Durable Object instance. It shares the core wire protocol, GameSession and delivery engine with the Node host. It has exact origin policy, bounded admission/rate limits, authentication revalidation, token/room/subject binding, takeover fencing, heartbeat/handshake timeouts and session expiry. It provides no native RTC, durable transport storage or hibernation restoration.
- New channel/Worker integration tests cover recovery, offline event replay, latest-state readiness, private room broadcast, explicit expiry, takeover and auth revalidation. The auto-connect helper cannot resurrect a client closed during its creation task.
- Added complete Node and Worker starter projects sharing an interactive two-tab client. They demonstrate authoritative movement, ordered pings, temporary interruption and checkpoint reload. Worker arenas use invite URLs and WebSocket; the Node starter can use native RTC.

Release validation is recorded in validation/STATUS.md. Game migrations and the website rollout have their own deployment receipts.

## 2.1.0 (2026-10-26)

- Snapshot generation age is checked continuously, including while the transport stays online. Old payloads in a
  receive backlog cannot keep advancing remote replay after its delay/prediction budget is exhausted. This holds
  the declared playback time and retains histories; it does not invent missing movement or hide present-position lag.

- `GameClient.receiveState` / `StateReceiver`: shared reconnect recovery for authoritative snapshot streams. It
  resets or retains application histories by policy, holds playback through offline and online-without-fresh-data
  phases, and accepts recovery only after a usable current-connection snapshot on the selected stream. New sessions
  always reset. Idle snapshot headers can release recovery; rejected deltas, queued old state and unrelated streams
  cannot. Raw callbacks and wire protocol 4 are unchanged. The party example uses the shared receiver.
- `AdaptivePlayback.updateDelay(dtMs)` separates delay adaptation from cursor movement. The receiver learns valid
  recovery-header lateness while holding its cursor, so a slower new route can recover without advancing old state.

- A proven RTC recovery now clears retry backoff, so an intermittent network outage does not inherit debt from an
  earlier recovered outage. Duplicate `rtc-reset` controls for an already-stopped attempt no longer increase that
  debt. This changes no wire bytes or application API. The native gate repeats three recoveries and injects duplicate
  resets; OS-level one-way UDP checks also retain their original failing observation and the candidate rerun.
- Queued traffic on a socket retired by session takeover is ignored, including a repeated hello. It cannot reclaim
  the player or produce misleading new protocol errors while its close is still in flight. Unauthenticated binary
  traffic on a new connection remains rejected.

## 2.0.0 (2026-10-25)

For shooters that send a snapshot every tick, and a smaller wire. Protocol version 4: server and clients upgrade
together (a 1.x peer can't talk to a 2.x one).

- **Frame header: 22 bytes to 12** (14 at most): one byte for version and kind, a 16-bit connection epoch, the stream as
  a varint, the 32-bit sequence number, and the time as quarter milliseconds from the connection's time base (sent in
  the welcome). A 64 Hz shooter's 35-byte inputs were more than a third header. The server reconnects a connection
  after four days so its frame times stay in range; the session resumes. `Endpoint.sendState` refuses a time its frame
  can't carry (more than `MAX_TIME_SPAN_MS` from the time base) when called, instead of throwing from a later flush.
- Removed what was only there for compatibility: `MAX_DATAGRAM_BYTES` (use `MTU_STATE_BYTES`) and the
  `new ReliableEvents(maxEvents, maxBytes)` form (pass an options object).

- **`GameServer({ pumpHz })`**: how often queued states and events go out (default 60, 10 to 250). At 64 or 128 Hz
  the default pump coalesced states between pumps, now and then dropping a tick from a stream interpolated two ticks
  behind; set the tick rate here, or `session.flush()` after each snapshot.
- **`PROFILES.fps64` / `fps128`**: a snapshot every tick, the bandwidth for it (96 / 192 KiB/s) and two ticks of render
  delay.
- **`AdaptivePlayback.track(timeline, sample, arrival)`** inserts a sample and counts its lateness, but not a timeline's
  first sample or a duplicate. Observing everything a join hands you (an idle player's state from a second ago) set
  the delay to hundreds of ms for every entity for about 9 s (kimu.nyc: 280 ms after a join, 40 ms with this).
- ADOPTING: a shooter section (send rate, bandwidth, inputs, datagram size, late states, lag compensation). API: a
  sample's `seq` is the sender's sequence number, never derived from a time that crossed the wire.

## 1.1.2 (2026-10-25)

- **Clock across reconnects**: a closed socket reset the client's clock, so through every outage `serverTime()`
  silently became the page's own time, and a playback that never goes backwards could lock onto that timeline and
  freeze after reconnecting to a restarted server (kimu.nyc measured remote players stuck and reversing for 10 s).
  The estimate is now kept through a drop (a resumed session talks to the same server, so the same clock) and starts
  over only with a new session; every welcome still brings a fresh burst of pings.
- **`AdaptivePlayback`** starts over when the clock jumps back by more than a second (a new server) instead of holding
  until the new clock passes the old cursor; a growing delay still never rewinds it.
- Docs: hold playback until `clock.synced`, and reset it in `onSession` when `resumed` is false.

## 1.1.1 (2026-10-25)

- **Page unload**: `bindPageLifecycle()` paused the session when a page closed or reloaded, so in a game without
  checkpoints the old player stood frozen for the whole resume grace while the reloaded page joined as someone new.
  Now a real unload (not the back/forward cache) leaves at once, unless the client checkpoints (`unload: 'auto'`, the
  default); `unload: 'pause'` or `'leave'` says so explicitly. Found by kimu.nyc's playtest.

## 1.1.0 (2026-10-25)

Accuracy improvements measured by porting a 50-player shared world (kimu.nyc) onto Twinwire, plus everything in 1.0.1.

- **Clock sync**: a burst of pings after each connect (`syncPings` 8, `syncPingMs` 250, then `pingMs` 1000) instead of
  one a second after the first reply, and `NetworkClock` jumps to an estimate more than `jumpMs` (50) away instead of
  slewing for seconds. With 50 clients on an emulated 5G link, the spread of their server-time estimates had stayed at
  20 to 27 ms; every sample's timestamp carries that error, so it widened everyone's interpolation delay.
- **`AdaptivePlayback`**: lateness is a time-decayed histogram (2 ms buckets, `halfLifeMs` 2000) instead of the last
  128 observations, so its memory is a span of time: fed one observation per snapshot at 60 Hz it had forgotten a
  congested cell's stalls within two seconds and under-sized the delay. `latenessMs` exposes the covered percentile.
- **Late states** (`endpoint.lateStates: 'deliver'`): a state overtaken by a newer one on its stream is delivered once
  with `late: true` (within the last 32, de-duplicated; acks still follow the newest), so a 60 Hz snapshot stream with
  jitter fills its interpolation buffer instead of losing every reordered snapshot. Default unchanged (`'drop'`).
- `GameSession.flush()` sends now instead of at the next 60 Hz pump. `sendEvent`, `broadcast` and `Room.send` accept
  typed interfaces (`JsonInput`), still checked when serialized.
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
