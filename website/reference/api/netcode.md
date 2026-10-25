# twinwire/netcode

Pure helpers that run in the browser and in Node. None of them touch the network: you call them with times and
values, which also makes them easy to test.

## Clock and timing

**`NetworkClock`** estimates the server's clock from ping exchanges. `observe(sent, received, remoteTime)` adds a
sample; it keeps the three lowest-round-trip samples of the last 16. `advance(dtMs)` slews toward the estimate by at
most 5% of the elapsed time. `serverTime(localTime)` never goes backwards. `synced`, `rttMs`, `uncertaintyMs`,
`reset()`. A `GameClient` has one as `client.clock`.

**`FixedStepper(hz = 30, maxCatchUp = 4)`**. `advance(elapsedMs, step)` calls `step(dtSeconds, tick)` once per fixed
step, at most `maxCatchUp` times per call, and returns how many ran. Time it couldn't catch up is dropped and counted
(`droppedMs`, `overruns`) instead of spiralling. `tick`, `dtMs`, and `alpha` (how far into the next step, for drawing).

**`PROFILES`**: starting rates for `social`, `action`, `strategy` and `turnBased` games, and `fps64` / `fps128` for
shooters that send a snapshot every tick (`simulationHz`, `sendHz`, `bytesPerSecond`, `interpolationMinMs`).

## Interpolation

**`Timeline<T>(capacity = 64, clone?)`**, one per entity. `insert({ time, seq, value, discontinuity? })` (false for a
duplicate), `sample(at, interpolate, extrapolate?, maxExtrapolationMs = 100)` returns `{ value, mode, sourceTime }`
with `mode` `interpolate`, `extrapolate` or `hold`, or null before the first sample. `size`, `clear()`. A
discontinuity takes effect at its own time and is never blended across.

**`AdaptivePlayback(intervalMs, minMs = intervalMs, maxMs = 400, { halfLifeMs = 2000, percentile = 0.95 })`** chooses
the render time. `observe(arrival, sampleTime)` on each arrival (both on the server clock); `advance(serverNow, dtMs)`
each frame returns the render time. The delay aims at the 95th percentile of recent lateness plus one interval, rising
fast and falling slowly. Lateness is a time-decayed histogram (2 ms buckets, each observation's weight halving every
`halfLifeMs`), so how much it remembers is a span of time, not a number of packets. `delayMs`, `latenessMs` (the
percentile), `reset()`. The render time never goes backwards, except when the clock itself jumps back by more than a
second (a restarted server): then it starts over from there. Call `reset()` in `onSession` when `resumed` is false,
and hold playback while `client.clock.synced` is false (until then `serverTime()` is the page's own time). The
client keeps its clock estimate through a dropped connection and starts over with a new session.

**`lerp(a, b, t)`**, **`lerpAngle(a, b, t)`** (the short way round), **`lerpVec3(a, b, t)`**.

**`rewindTime(requested, now, maxRewindMs)`** clamps a lag-compensation request to the window you allow. It does not
judge hits.

## Prediction and inputs

**`Predictor<S, I>(initial, step, dtSeconds = 1/60, maxPending = 256, cloneState?, cloneInput?)`**.
`push(input)` predicts and returns `{ seq, value }`; `reconcile({ ack, tick, state })` takes the server's state,
drops inputs up to `ack` and replays the rest (false for a snapshot not newer than the last); `recent(n = 3)` the last
inputs, for redundant sends; `resync(state, tick, ack = 0)` starts over. `state`, `lastInput`, `pendingCount`. Throws
when more than `maxPending` inputs are unconfirmed: resync then.

**`InputInbox<I>(capacity = 256, clone?)`** on the server. `add({ seq, value })` (false for old or duplicate inputs),
`next()` the next input in order or null, `applied` (the ack to send back), `skipThrough(seq)` to give up on a gap.
Skipping is never automatic.

**`encodeInputs(inputs)`** packs up to 32 `{ seq, data }` inputs (each up to 1024 bytes, in increasing seq order) into
one state payload; **`decodeInputs(bytes)`** unpacks them, or returns null.

## Snapshots and replication

**`SnapshotHistory<T>(capacity = 64)`**, one per receiver. `record(seq, value)` after each `sendState(..., { ack:
true })`; `acknowledge(seq)` from `onStateAck`; `baseline` is `{ seq, value }` of the newest acknowledged snapshot, or
null; `reset()` on a new connection.

**`diffEntities(base, next)`** returns `{ set?, del? }` between two `{ [id]: { field: value } }` maps; a removed field is
`null`. **`applyEntityDelta(base, delta)`** rebuilds the full map without touching its inputs.

**`ReplicaSender(maxEntities = 1024, retryMs = 100)`**, one per receiver: `publish(id, generation, data | null)`
(ids up to 65535, data up to 1067 bytes, null to delete), `due(now, limit = 64)` the records to send, `markSent(version,
now)`, `acknowledge(version)`, `clear()`. **`ReplicaReceiver(maxEntities = 1024)`**: `apply(update)` returns `{ changed,
ack }`; `get(id)`; `clear()`. **`encodeReplica`** and **`decodeReplica`** for the wire.

## Codecs and space

**`defineSchema(fields)`** makes a fixed binary layout: each field is `{ type, scale? }` with `type` one of `u8`, `i8`,
`u16`, `i16`, `u32`, `f32`, `f64`. Integer fields are scaled and rounded (`{ type: 'i16', scale: 10 }` keeps one
decimal). The result has `byteLength`, `encode(value)` (throws when a value is out of range) and `decode(bytes)` (null
for the wrong length). A layout must fit one datagram (1078 bytes).

```ts
const player = defineSchema({ x: { type: 'i16', scale: 10 }, y: { type: 'i16', scale: 10 }, hp: { type: 'u8' } });
player.encode({ x: 12.3, y: -4, hp: 90 });   // 5 bytes
```

**`SpatialGrid<Id>(cellSize = 32, maxEntities = 10000)`**: `upsert(id, { x, y })`, `remove(id)`, `query(center,
radius)` returns a `Set` of ids. A query may touch at most 4096 cells. It answers who is near, not who may see.
