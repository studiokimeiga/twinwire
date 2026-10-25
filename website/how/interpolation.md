# Snapshot interpolation

<p class="lede">The server sends where everyone is 20 times a second. The screen draws 60 or 120 times a second, and the
snapshots arrive late, early, out of order, or not at all. Interpolation turns that into smooth motion by drawing
everyone else slightly in the past.</p>

## Draw the past, smoothly

If you draw another player where the newest snapshot says, they jump 20 times a second, and every late or lost
snapshot is a visible stall. Instead, Twinwire keeps a short history of snapshots for each entity (a `Timeline`) and
draws each frame at a **render time** a little behind the server's clock. At that time there is almost always a
snapshot before and one after, so the position can be blended between two real positions the server sent.

The cost is delay: you see other players as they were a fraction of a second ago. The question is how far behind to
draw: too little and late snapshots cause stalls, too much and everything feels sluggish.

## Try it

A real `Timeline` and `AdaptivePlayback`, fed by snapshots across a simulated network.

<InterpolationDemo />

Things to try:

- **Turn interpolation off.** The object is drawn where the newest snapshot says: steps instead of motion, and a
  freeze whenever a snapshot is late.
- **Raise the jitter.** With the adaptive delay on, the playback delay grows until late snapshots are covered again.
  Lower it, and the delay comes back down slowly.
- **Turn the adaptive delay off** and raise the jitter: the render time overtakes the snapshots it has, and the object
  holds still (red ring) until the next one arrives.
- **Raise the loss and turn on extrapolation.** Past the newest snapshot, the object keeps going in the direction it
  was moving, for up to 250 ms here (100 ms by default), instead of stopping. Guesses overshoot on turns.

## How far behind

`AdaptivePlayback` measures it instead of guessing. For every snapshot that arrives it records how late it was: the
time it arrived on the server's clock minus the time it describes. The delay it aims for is the 95th percentile of
the recent lateness, plus one snapshot interval, within the bounds you give. It moves toward that target quickly when
it needs to grow and slowly when it can shrink, so a burst of jitter is covered at once and a calm spell doesn't make
playback jumpy.

```js
import { Timeline, AdaptivePlayback, lerp } from 'twinwire/netcode';

const SNAP_HZ = 20;
const playback = new AdaptivePlayback(1000 / SNAP_HZ, 1000 / SNAP_HZ, 300);   // interval, min and max delay (ms)
const others = new Map();                                                     // seat -> Timeline

net.onState = s => {
  const snap = decode(s.data);
  playback.observe(net.clock.serverTime(performance.now()), s.time);           // how late was this one?
  for (const p of snap.players) {
    let tl = others.get(p.seat); if (!tl) others.set(p.seat, tl = new Timeline(32));
    tl.insert({ time: s.time, seq: snap.tick, value: { x: p.x, y: p.y } });
  }
};

function frame(now, dt) {
  const renderTime = playback.advance(net.clock.serverTime(now), dt);
  for (const [seat, tl] of others) {
    const r = tl.sample(renderTime, (a, b, u) => ({ x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u) }));
    if (r) draw(seat, r.value);                                               // r.mode: interpolate, extrapolate, hold
  }
}
```

Here every snapshot is stamped when the server sends it, so it is observed once. If your entities carry their own
sample times instead (sent when they change, idle ones re-sent now and then), feed each one through
`playback.track(timeline, sample, arrival)`: it skips a timeline's first sample, because what a join hands you was
already old and says nothing about the network, and duplicates. Give samples the sender's sequence number as `seq`,
never one worked out from a time that crossed the wire.

## The sample

`timeline.sample(at, interpolate, extrapolate?, maxExtrapolationMs = 100)` finds the snapshots on either side of `at`
and returns one of three things:

| Mode | When | Value |
|---|---|---|
| `interpolate` | There are snapshots before and after `at` | Your `interpolate(a, b, fraction)` |
| `extrapolate` | `at` is past the newest snapshot, and you passed `extrapolate` | Your `extrapolate(last, previous, aheadMs, intervalMs)`, at most `maxExtrapolationMs` ahead |
| `hold` | Past the newest, without extrapolation (or at a discontinuity) | The newest snapshot |

It returns `null` before the first snapshot. `lerp`, `lerpAngle` (the short way round) and `lerpVec3` are there for
the usual cases.

**Teleports.** Mark a snapshot `discontinuity: true` when an entity jumps (a respawn, a door to another room). It
takes effect at its own time and is never blended across, so nobody slides across the map.

## The clock under it

Render times are on the server's clock, which the page estimates with `NetworkClock`. Each ping is a sample of the
offset between the two clocks. It keeps the three samples with the lowest round trip out of the last 16 (the ones
least distorted by queueing), and slews toward their average by at most 5% of elapsed time, so the estimate never
jumps and `serverTime()` never goes backwards. `clock.rttMs` and `clock.uncertaintyMs` say how good the estimate is.
`GameClient` runs one for you: `net.clock`.

Interpolation is for everyone else. Your own player can't wait a fraction of a second for the server, so it is
predicted instead: [prediction and reconciliation](/how/prediction).
