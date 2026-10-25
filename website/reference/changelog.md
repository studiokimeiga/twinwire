# Changelog

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
