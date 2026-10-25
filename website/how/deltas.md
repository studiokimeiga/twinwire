# Delta snapshots

<p class="lede">Most of a world doesn't change between two snapshots. Sending only what did change is a large saving,
but only if the delta is taken against a snapshot the player really has. Twinwire tells you which one that is.</p>

## Deltas need a baseline the player has

A delta is "what changed since snapshot N". If the player never got snapshot N (states are latest-wins, and datagrams
get lost) the delta is useless, and applying it would build a wrong world.

So the delta is taken against a snapshot the player has **acknowledged**. Send states with `ack: true`, and the
receiver reports the newest one it saw, at most every 50 ms, on the datagram path when it is up. The server keeps
what it sent by sequence number (`SnapshotHistory`), and each new snapshot is a delta against the newest acknowledged
one. A lost snapshot costs nothing except a slightly larger next delta, because nothing ever depends on it.

## Try it

Two real endpoints: states sent with `ack: true`, acknowledgements coming back as state-ack frames, a `SnapshotHistory`
on the server, `diffEntities` to make each delta and `applyEntityDelta` to rebuild the world in the browser. Every
snapshot the browser builds is checked against the world the server sent.

<DeltaDemo />

Things to try:

- **Turn deltas off and on.** Each bar is one snapshot; the grey behind it is what the whole snapshot would cost.
- **Raise the loss.** Some snapshots never arrive (red), the baseline gets a little older, and the deltas grow a
  little. The browser still matches the server on every snapshot it builds.
- **Change how much moves each tick.** Deltas save the most when most of the world is still.

## In code

On the server, one history per player:

```js
import { SnapshotHistory, diffEntities } from 'twinwire/netcode';

const history = new SnapshotHistory();                     // one per player
session.onStateAck = (stream, seq) => history.acknowledge(seq);

function sendSnapshot(world) {                             // world: { [id]: { field: value } }
  const base = history.baseline;                           // null: send everything
  const seq = session.sendState(0, encode({ b: base?.seq ?? 0, d: diffEntities(base?.value ?? null, world) }), { ack: true });
  history.record(seq, structuredClone(world));
}
```

In the browser, keep the worlds you've built by sequence number, so a delta can find its base:

```js
import { applyEntityDelta } from 'twinwire/netcode';

const built = new Map();                                   // seq -> world
net.onState = s => {
  const msg = decode(s.data);
  const view = applyEntityDelta(msg.b ? built.get(msg.b) ?? null : null, msg.d);
  built.set(s.seq, view);
  show(view);
};
```

## The format

`diffEntities(base, next)` compares two maps of entities (`{ [id]: { field: value } }`) field by field and returns
`{ set, del }`: the changed fields of each entity, and the ids that are gone. A field that disappeared is sent as
`null`. `applyEntityDelta(base, delta)` rebuilds the full map without touching its inputs. A null field and a missing
field mean the same thing.

**Reset both sides on a new connection.** Sequence numbers restart with each connection epoch, so call
`history.reset()` on the server and clear your map in the browser when the session reconnects (`onSession`).

## Acknowledged records

Some things change rarely and must not be missed: a door's state, a player's name, an item on the floor.
`ReplicaSender` and `ReplicaReceiver` resend each small record (up to 1067 bytes) until it is acknowledged, with a
generation number so a reused id is never confused with the entity that had it before. Unlike deltas, they don't
depend on any baseline.

```js
import { ReplicaSender, encodeReplica } from 'twinwire/netcode';

const replicas = new ReplicaSender();                      // one per receiver
replicas.publish(doorId, generation, encodeDoor(door));    // null data: deleted
for (const u of replicas.due(performance.now())) {         // what needs (re)sending now
  queue(encodeReplica(u)); replicas.markSent(u, performance.now());
}
// when the receiver's ack for { id, generation, revision } comes back: replicas.acknowledge(ack)
```
