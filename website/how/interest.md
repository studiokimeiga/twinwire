# Interest management

<p class="lede">A player doesn't need the whole world, only what is near enough to matter. Sending each player just
that is the biggest bandwidth saving most games have, and it is what makes a $5 server viable.</p>

## Who is near whom

Checking every entity against every player costs players times entities each tick. A spatial grid makes it cheap:
the world is cut into square cells, each entity is filed under the cell it stands in, and a query looks only in the
cells its circle touches.

## Try it

Twinwire's real `SpatialGrid`, with every entity moved and re-filed each frame.

<InterestDemo />

Things to try:

- **Drag the player** around the map. Only the dark dots go into their snapshot.
- **Change the cell size.** Small cells fit the circle tightly but mean more cells per query. Large cells mean few
  cells but many entities checked that turn out to be too far. A cell about the size of the view radius, or half of
  it, is a good start.
- **Add entities.** The cost of a query grows with the entities near the player, not with the size of the map.

## In code

```js
import { SpatialGrid } from 'twinwire/netcode';

const grid = new SpatialGrid(64);                   // cell size, in your world's units

// each tick, after the simulation
for (const e of world.entities) grid.upsert(e.id, e);          // anything with x and y
for (const id of world.removed) grid.remove(id);

for (const m of room.members.values()) {
  if (!m.connected) continue;
  const near = grid.query(m.data.position, 400);    // ids within 400 units
  const visible = [...near].filter(id => canSee(m, id));   // your rules: teams, fog of war, line of sight
  m.session.sendState(0, encodeSnapshot(visible));
}
```

The grid answers "who is near", never "who may see". Apply your own visibility rules before anything goes into a
snapshot, so a modified client can't learn what its player shouldn't know.

## Limits

`SpatialGrid(cellSize = 32, maxEntities = 10000)`. A query may touch at most 4096 cells, so a huge radius with tiny
cells is refused rather than slow. Positions must be finite and within ±10⁸.

Interest goes well with the other savings: a [delta](/how/deltas) of only the nearby entities, at a modest rate for
social and co-op games (10 to 20 snapshots a second), with [acknowledged records](/how/deltas#acknowledged-records) for
the things that rarely change.
