# Adopting Twinwire in an existing game

Most games that come to Twinwire already have netcode of some kind: a WebSocket, maybe geckos.io or a hand-rolled
WebRTC path, a reliability layer, rooms. Swap the transport first and keep the game's own model of the world; then
move pieces onto Twinwire's helpers only where they're better than what you have.

## A staged path

1. **Keep your world, swap the wire.** Leave the simulation, the snapshot format and the rendering alone. Replace the
   connection code with a `GameClient` on the page and `createGameServer` on the server, behind a flag if you can.
2. **Sort your traffic into two kinds.**
   - Things that must arrive, in order (hits, doors, purchases, chat, map changes): `sendEvent`. Remove any old
     reliability layer on that path instead of running two acknowledgement schemes.
   - Things where only the newest matters (positions, snapshots, inputs): `sendState` on a stable stream number.
3. **Stamp what depends on time.** Events and states travel separately, so nothing orders one against the other.
   Put the server tick (or a map/world generation number) in each event, and in each snapshot; a snapshot that belongs
   to a change the client hasn't heard about yet waits for it, and one from before a change is dropped.
4. **Rooms on the lobby.** Codes, quick play, seats and build matching come from `Lobby`/`LobbyClient`. Put the build
   id in room `meta` (`match` for quick play, `canJoin` for codes), and keep your world in `room.data`. Seats survive
   reconnects through the session itself; `onReconnect` is where your world re-sends whatever a fresh client needs.
5. **Then the helpers, if they beat yours.** Deltas against acknowledged snapshots (`ack: true`, `SnapshotHistory`),
   interpolation (`Timeline`, `AdaptivePlayback`), prediction (`Predictor`, `InputInbox`, `encodeInputs`).

## Defaults to check

- `maxPerIp` (32 sockets and sessions per address): load tests with many bots from one machine, and players behind
  one school or office address, need it raised.
- `endpoint.bytesPerSecond` (32 KiB/s per peer): a busy shared world can need more downstream (one social game
  measured 40 to 55 KB/s per player at 50 players). Set it on the server's `endpoint` option.
- The lobby sends each member the whole room (every member) on every join, leave, ready or name change. That is cheap
  for 2 to 8 players; a 64-player social room should keep names and looks in its own events and use the lobby only
  for seats.

- Reloads: a game without checkpoints (every reload is a new player) wants the old session gone at once, which
  `bindPageLifecycle()` does by default; one that saves `checkpoint()` on `pagehide` to keep the seat across a reload
  should pass `{ unload: 'pause' }`.
- Trying a new Twinwire build from a tarball under Vite: its dev server keeps serving the dependency it pre-bundled
  (in `node_modules/.vite`) after `npm install`. Delete that folder, or start Vite with `--force`, or you are still
  testing the old build.

## Sizes

A state can be up to 64 KiB (`maxStateBytes`, up to 256 KiB), but a per-tick packet that fits 1078 bytes fits one
datagram on any path. Bigger states are fragmented by SCTP on the datagram path, and anything over `datagramStateBytes`
(8 KiB) takes the WebSocket instead, where it can't be lost piecewise: fine for a whole snapshot after a map change, not
for every tick. Events are JSON up to 64 KiB each.

## By kind of game

- **Action games (shooters, platformers, fighting):** keep your own movement, collision and hit rules on the server.
  Send inputs redundantly (`encodeInputs` with the last few), apply them with `InputInbox`, and reconcile on the client.
  A shot that matters is an event that names the input/tick it came from, so the server can check it against its own
  history.
- **Shooters at 64 or 128 Hz:** a snapshot every tick, so start from `PROFILES.fps64` / `fps128`:
  - Send each tick's snapshot as it's made: `GameServer({ pumpHz: 64 })` (or 128), or `session.flush()` right after
    `session.sendState(...)`. The default 60 Hz pump coalesces states between pumps, which at 64 Hz now and then drops
    a tick from a stream you interpolate two ticks behind.
  - Give the endpoints the bandwidth: `endpoint: { bytesPerSecond: PROFILES.fps64.bytesPerSecond }` on the server and
    the client (the 32 KiB/s default is less than a 500-byte snapshot every tick).
  - Inputs: `client.sendState(stream, encodeInputs(predictor.recent(n)))` and `client.flush()` each tick, so a lost
    datagram is covered by the next; at 128 Hz, raise `rateLimit.messages` above 300 if inputs, pings and acks get close.
  - Keep a snapshot under 1078 bytes (one datagram on any path); a bigger world splits it across streams, so a loss
    touches only part of it.
  - Render others with `AdaptivePlayback(1000 / hz, PROFILES.fps64.interpolationMinMs)`, and receive with
    `endpoint: { lateStates: 'deliver' }` so a reordered snapshot still fills its place.
  - Lag compensation is yours: keep a short history of hitboxes per tick on the server and rewind to what the shooter
    saw (`rewindTime` clamps the request); a shot is an event naming its tick.
- **Social and co-op worlds:** interest-filter what each player gets (`SpatialGrid` for "who is near"), send compact
  records at a modest rate (10-20 Hz), and acknowledged records (`ReplicaSender`) for things that change rarely.
- **Strategy:** commands are events, applied by the server; snapshots at the simulation's own rate.
- **Turn-based:** WebSocket only (`rtc: false`): there's nothing for UDP to speed up.

## A real port: Nocturne Keep

[Nocturne Keep](https://nocturnekeep.com) is a pixel-art platformer whose rooms run the game's own code headless on
the server (a Node `vm` per room, each in its own worker thread), with each phone simulating only its own player.
Before Twinwire it used geckos.io for WebRTC, a separate WebSocket fallback, and a Quake-3-style reliable layer that
repeated unacknowledged messages in every packet.

- The page's connection code (about 120 lines) became a `GameClient` and a `LobbyClient`; the server's hello, codes,
  quick play and seat tokens became `Lobby` callbacks.
- The reliable layer went away on both sides. Its messages are events, each stamped `[serverFrame, message]`.
- Its JSON snapshots, already deltas against the last snapshot the phone acknowledged, stayed exactly as they were:
  they became stream 0 states, with the map-change number added so a snapshot that beats its map event waits for it.
- A reload keeps the seat: the page saves `checkpoint()` in sessionStorage and resumes it when the player rejoins.
- All of its multi-browser suites (co-op story, every map, every boss, maker rooms, races, the roguelike together) pass
  over WebRTC, and its live check plays the public site in Chromium and WebKit.

## Checks worth copying

- Two browsers agree on the same world at the same tick (same enemies, same positions within a tolerance).
- A lost stop or state change heals by itself (the next state repairs it).
- Both directions survive UDP failing while the WebSocket stays up (`IMPAIR`, `RTC=0` in the browser test).
- A phone that drops (tunnel, app switch) comes back to its seat; a reload with a checkpoint too.
- Measure before and after with the same inputs: corrections, input-to-visible delay, missed snapshots, bytes.
