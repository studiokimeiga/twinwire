# API and integration

All modules are ESM with TypeScript declarations.

| Import | For |
|---|---|
| `twinwire/client` | Browser: `GameClient`, `LobbyClient`, `BrowserRtcPeer` |
| `twinwire/server` | Node: `createGameServer`, `GameServer`, `GameSession`, `Lobby`, `Room`, `createNativeRtcFactory`, `turnCredentials`, `cloudflareTurn` |
| `twinwire/netcode` | Both: clock, interpolation, prediction, timing, snapshots, replication, codecs, spatial |
| `twinwire` | Both: the wire protocol and `Endpoint` |
| `twinwire/browser` | `dist/browser/twinwire.js` (also `.min.js`; ESM `.mjs` for `import`): client + lobby + netcode as `window.Twinwire` |

Browser code never imports the server entry. Node needs `ws`; WebRTC on the server needs `node-datachannel@0.33.x`.

## GameClient

```ts
const client = new GameClient({
  url: 'wss://game.example.com/connect',
  room: 'mygame',                 // a namespace the server sees; rooms with codes come from the lobby
  auth: { name: 'WREN', build },  // any JSON, checked by the server's authenticate hook; also session.hello
  rtc: {},                        // default. false = WebSocket only. { iceServers } overrides the server's list
  endpoint: { bytesPerSecond: 32 * 1024 },
});
```

| Member | Contract |
|---|---|
| `connect()` | Starts join/resume and pumping. |
| `whenOnline()` | Promise: resolves when online (at once if already), rejects if the session is lost or closed first. |
| `status`, `onStatus(s)` | `idle`, `connecting`, `online`, `paused`, `closed`, `lost`. |
| `transport`, `onTransport(t)` | `rtc` (datagrams proven both ways), `ws`, `none`. |
| `onSession({id,resumed})` | Identity is available. `resumed: false` means a brand-new session: reset game state. |
| `onSessionLost({pendingEvents,reason})` | Expiry, kick, takeover by another tab, authentication or protocol rejection. Retrying stops; call `newSession()`. |
| `sendEvent(json)` | Ordered, acknowledged, deduplicated; replayed after reconnects. Returns its seq; throws when the outbox is full (512 events / 1 MiB) or the event is over 64 KiB. |
| `onEvent(data, seq)` | Each event exactly once, in order, whichever path brought it first. |
| `sendState(stream, bytes, {ttlMs, priority, ack}?)` | Latest wins per stream (0 to 65535). Returns the seq, or 0 before the session is online and the clock synced. Up to `maxStateBytes` (64 KiB). |
| `onState({stream,seq,time,data,via,late})` | Newer than anything seen on that stream this connection (or, with `endpoint.lateStates: 'deliver'`, an overtaken one not seen before, `late: true`). `time` is the sender's server-clock estimate: never trust it for authority. |
| `onStateAck(stream, seq)` | For states sent with `ack: true`: the newest the peer has seen. |
| `iceServers` | What the server suggested in its welcome. |
| `clock` | `synced`, `rttMs`, `uncertaintyMs`, `serverTime(performance.now())`. |
| `pause()` / `resume()` | Close and reopen the connection, keeping the session. |
| `reconnectNow()` | Skip the backoff (the network came back). |
| `newSession()` | Drop the old session and its unsent actions; get a new identity. |
| `close()` | Leave for good (the server ends the session at once). |
| `checkpoint()` / `options.checkpoint` | Carry a session across page loads. Holds a bearer token: never put it in a URL. |
| `bindPageLifecycle({hiddenPauseMs, wakeCheckMs, unload})` | Pause after 20 s hidden, or when the page goes into the back/forward cache; when the page is back, resume, or replace a socket that stays silent for 1.5 s; reconnect at once on `online`. When the page really unloads: `unload: 'leave'` ends the session at once (no frozen player for the resume grace), `'pause'` keeps it for a checkpointed reload, `'auto'` (default) pauses only if the client checkpoints. Say `'pause'` if you call `checkpoint()` in your own `pagehide` handler. |
| `intercept(fn)`, `on('session' \| 'lost', fn)` | Extra listeners for helpers such as `LobbyClient`. |
| `endpoint.stats` | Traffic, stale/expired/coalesced states, `eventsViaDatagram`, `datagramRttMs`, and more. |
| `options.impair` | `{lagMs, jitterMs, loss, duplicate, stallMs}` on this client's sends, and asked of the server (which honours it only with `allowImpairment`). `lagMs` is one way. `loss` drops datagrams; with `stallMs`, it also stalls the WebSocket (a lost TCP segment holds up everything behind it while it is resent). |
| `onError(e)`, `flush()` | Errors that don't end the session; send what's queued now instead of at the next pump. |
| `simulateDrop()` | Close the socket as a network drop would (testing): the client reconnects and resumes. |

| Option | Default | |
|---|---|---|
| `reconnectBaseMs` / `reconnectMaxMs` | 200 / 8000 | Reconnect backoff, doubling each try, with jitter. |
| `heartbeatTimeoutMs` | 8000 | A socket silent this long is replaced. |
| `rtcRetryMs` | 3000 | Wait before retrying a data channel that failed; doubles per failure up to 16×, at most 60 s. |
| `rtcConnectTimeoutMs` | 8000 | Give up on a data channel that hasn't proven itself by then. |
| `pumpHz` | 60 | How often queued states and events are scheduled onto the wires. |
| `syncPings` / `syncPingMs` / `pingMs` | 8 / 250 / 1000 | Clock sync: a burst of pings after each connect, then one a second. |
| `websocket` | `u => new WebSocket(u)` | Socket factory (tests, Node clients, proxies). |

Callbacks should be short. Don't throw from `onEvent` after side effects: a throw means "not accepted", and the same
event is offered again, in order, about 100 ms later (whichever wire brought it). A throw from `onState` or `onStateAck`
drops that one message. Either way the connection carries on and the error goes to `onError`.

## LobbyClient

```ts
const lobby = new LobbyClient(client);
const room = await lobby.create({ mode: 'night', visibility: 'private', maxMembers: 4, meta: { build } });
await lobby.join('KQXT');                       // case-insensitive
await lobby.quickPlay({ mode: 'night', match: { build }, create: { maxMembers: 4 } });
await lobby.setReady(true); await lobby.setName('WREN'); await lobby.setMeta({ skin: 2 });
await lobby.kick(2); await lobby.leave();
lobby.onRoom = room => {};   // RoomView | null on every change
lobby.onLeft = reason => {}; // kicked, replaced, closed, expired, new session
lobby.room; lobby.me; lobby.isHost; lobby.countdownMs();
```

`RoomView`: `{ code, mode, visibility, phase, maxMembers, meta, you, members: [{seat, name, ready, connected, host, meta}], countdownEndsAt }`.
Requests reject with the server's message (`no room called ZZZZ`, `that room is full`, your `canJoin` text). Lobby
traffic uses events with a `$lobby` key; `onEvent` never sees them.

## Server

```ts
const server = await createGameServer({
  host: '127.0.0.1', port: 8787, origins: ['https://game.example.com'],
  rtc: await createNativeRtcFactory({ port: 8788, maxMessageSize: 64 * 1024 + 22 }),
  iceServers: session => [turnCredentials({ secret: process.env.TURN_SECRET, urls: 'turn:turn.example.com:3478', user: session.id })],
  trustProxy: true, resumeGraceMs: 90_000,
  authenticate: ({ auth, room, resuming, ip }) => validBuild(auth) ? 'anon' : null,
  endpoint: { bytesPerSecond: 48 * 1024 },
});
await server.listen();
```

| Option | Default | |
|---|---|---|
| `origins` | required | Exact page origins. `allowMissingOrigin` lets non-browser clients in. |
| `rtc` | none | `createNativeRtcFactory({port, publicIp?, bindAddress?, iceServers?, maxMessageSize?})`. Without it: WebSocket only. |
| `iceServers` | `[]` | Array or `(session) => array \| Promise`. Sent in each welcome. |
| `trustProxy` | false | Read the client address from the last `X-Forwarded-For` hop when the peer is a local proxy. |
| `resumeGraceMs` | 90 000 | How long a dropped session (and its lobby seat) waits. |
| `pumpHz` | 60 | How often queued states and events go out. A game ticking faster sets its tick rate (10 to 250), or calls `session.flush()` after each snapshot. |
| `maxSessions` / `maxConnections` / `maxPerIp` | 256 / 512 / 32 | Sessions (connected or waiting to resume), sockets, and sockets per address. |
| `maxSessionsPerIp` | `maxPerIp` | Sessions per address. At the limit a new one replaces that address's longest-disconnected session, so one address can't fill the table. |
| `rateLimit` | 300 msg/s, 256 KiB/s | Per connection, both transports together. |
| `allowImpairment` | false | Honour a client's `impair`. Development only. |
| `endpoint` | | Endpoint options for every session (below). |
| `path` | `/connect` | The WebSocket path. |
| `heartbeatTimeoutMs` / `handshakeTimeoutMs` | 15 000 / 5 000 | Drop a connection that goes silent, or that doesn't finish its hello in time. |
| `http` | 404 | `(req, res)` for every other HTTP request (`/health`, your pages). |
| `onError`, `onSession`, `onDisconnect`, `onExpire` | | Callbacks, also settable as properties. |

| Member | |
|---|---|
| `sessions` | Map of id to `GameSession`: `id`, `room`, `subject`, `ip`, `hello` (latest `auth`), `connected`, `transport`, `data` (yours), `sendEvent`, `sendState`, `flush()` (send now, not at the next 60 Hz pump), `onEvent`, `onState`, `onStateAck`, `endpoint`. |
| `on('session' \| 'disconnect' \| 'expire', fn)` | Listeners beside `onSession` / `onDisconnect` / `onExpire`. |
| `endSession(session, reason)` | Kick: the client gets `onSessionLost(reason)`. |
| `broadcast(room, json)` | To every session that said hello with that `room`. |
| `metrics()` | Sessions, connections, rtc/ws counts, bytes, pending events, protocol errors. For `/health`. |
| `addressOf(req)` | The address the limits use. |

## Lobby

```ts
const lobby = new Lobby(server, {
  maxMembers: 4, codeLength: 4, emptyCloseMs: 30_000,
  joinablePhases: ['lobby', 'playing'],   // join by code mid-game (drop-in)
  quickPlayPhases: ['lobby'],             // quick play only into rooms still waiting
  ready: { countdownMs: 3000, minMembers: 1 },  // or false
  evictDisconnected: true, allowHostKick: true, maxRoomsPerIpPerHour: 30,
  clientMetaKeys: ['skin'],                 // meta keys members may set themselves (default: any)
  canCreate: (session, req) => null,      // or an error message
  canJoin: (room, session, req) => room.meta.build !== session.hello?.build ? 'A NEW VERSION IS OUT' : null,
});
```

The lobby owns each session's `onEvent`/`onState`; use its callbacks: `onCreate(room, creator)`, `onJoin(room, member)`,
`onLeave(room, member, reason)`, `onDisconnect`, `onReconnect`, `onStart(room)`, `onClose(room, reason)`,
`onEvent(room, member, data, session)`, `onState(room, member, state, session)`. `room`/`member` are null for a
session that isn't in a room.

`Room`: `code`, `mode`, `visibility`, `phase`, `meta`, `data` (yours), `members` (by session id), `host`,
`memberAt(seat)`, `connectedCount`, `broadcast(json, except?)`, `send(member, json)`, `setPhase(p)` (`'lobby'` clears
ready), `setMeta(patch)`, `setVisibility(v)`, `start()`, `close(reason)`. `Member`: `session`, `seat` (stable),
`name`, `ready`, `connected`, `meta`, `data` (yours). `lobby.createRoom(...)`, `roomOf(session)`, `memberOf(session)`.

A member keeps its seat while disconnected, until its session expires (`resumeGraceMs`). Seats are the lowest free
number. The first member is the host; when the host leaves or drops, the earliest-joined connected member takes over,
and keeps the role when the old host comes back (so it doesn't flip back and forth on a shaky connection).

Quick play joins a public room of that mode whose `meta` matches and that has a free seat, an allowed phase and at
least one connected player: the fullest first, then the newest. Otherwise it creates one. `maxRooms` (500) caps rooms
on the server. The ready countdown starts when every connected member (at least `minMembers`) is ready; an unready,
a join, a leave or a drop cancels it, but name and meta changes don't. `LobbyClient` requests time out after 20 s
(its second constructor argument).

## Endpoint options

`bytesPerSecond` (32 KiB) and `burstBytes`: scheduling budget for states and events (a message bigger than the burst
goes once the bucket is full). `maxBufferedBytes` (64 KiB): socket backpressure. `maxStateBytes` (64 KiB, at most
256 KiB). `datagramStateBytes` (8 KiB): bigger states use the WebSocket. `datagramEvents` (true). `stateAckIntervalMs`
(50). `probeIntervalMs`/`probeTimeoutMs` (250/1500). `maxStreams` (1024). `events: {maxEvents, maxBytes,
maxEventBytes, maxEarly, maxEarlyBytes}` (512, 1 MiB, 64 KiB, and 256 events / 256 KiB waiting for a gap). `lateStates`
(`'drop'`): `'deliver'` passes on an overtaken state once, within the last 32 of its stream, with `late: true`. `impair`. Both ends should agree on `maxStateBytes`.

## Netcode

**Clock and timing.** `NetworkClock` (the client has one). `FixedStepper(hz, maxCatchUp)` runs a fixed simulation
step and reports dropped time instead of spiralling. `PROFILES` has starting rates for social, action, strategy and
turn-based games, and `fps64` / `fps128` for shooters that send a snapshot every tick (see ADOPTING.md).

**Snapshot interpolation.** One `Timeline` per entity, `AdaptivePlayback(intervalMs, minMs?, maxMs?, {halfLifeMs,
percentile}?)` to choose a render time that covers the jitter you actually see: `observe(clock.serverTime(now),
state.time)` on arrival when each snapshot is stamped as it's sent (everything in it current); when entities carry
their own sample times (sent as they change, idle ones re-sent), `playback.track(timeline, sample,
clock.serverTime(now))` per entity instead, which inserts and counts lateness but not a timeline's first sample (what a
join or resync hands you was already old) or a duplicate. A sample's `seq` is the sender's sequence number (a tick, a
state seq), never derived from a time that crossed the wire. `advance(serverNow, dt)` per frame, then `timeline.sample(renderTime, lerp, extrapolate?,
maxMs)`. Lateness is a time-decayed histogram (half-life 2 s), so its memory doesn't depend on how many snapshots
arrive; `latenessMs` is the covered percentile. Mark teleports as `discontinuity`. With `endpoint: { lateStates:
'deliver' }`, a snapshot overtaken by a newer one still arrives (`late: true`) and can fill its place in the timeline.

**The server clock** is the server process's `performance.now()`: it starts near zero and restarts with the process.
For wall-clock time (a time of day), add `performance.timeOrigin` on the server and send it. The client's estimate is
kept through a dropped connection (a resumed session talks to the same process, so the same clock) and starts over with
a new session (`onSession` with `resumed: false`, which is also what a restarted server gives). Until the first sync,
`clock.synced` is false and `serverTime()` is the page's own time: hold playback until synced, and reset your
playback (`playback.reset()`, the timelines) in `onSession` when `resumed` is false. `AdaptivePlayback` also starts over
by itself if the clock jumps back by more than a second, rather than freezing until the new clock catches up.

**Prediction.** `Predictor(initial, step, dt)`: `push(input)` predicts, `recent(n)` for redundant sends
(`encodeInputs`), `reconcile({ack, tick, state})` replays what the server hasn't applied. The server feeds
`InputInbox` and acks the last input it applied. `rewindTime` clamps lag-compensation requests.

**Delta snapshots.**

```ts
const history = new SnapshotHistory<Entities>();   // one per player
session.onStateAck = (stream, seq) => history.acknowledge(seq);
const base = history.baseline;                       // null: send everything
const seq = session.sendState(0, encode({ b: base?.seq ?? 0, d: diffEntities(base?.value ?? null, world) }), { ack: true });
history.record(seq, world);
// client: view = applyEntityDelta(states.get(msg.b) ?? null, msg.d); states.set(s.seq, view)
```

Reset both sides when the connection epoch changes (`onSession`). A null field and a missing field are the same.

**Acknowledged records.** `ReplicaSender`/`ReplicaReceiver` resend whole small entity records until acknowledged,
with generations for reused ids.

**Codecs and interest.** `defineSchema({x: {type: 'i16', scale: 10}, ...})` for fixed binary layouts.
`SpatialGrid` for "who is near whom"; your rules still decide who may see what.

## Limits worth knowing

No order holds between events and states: stamp events with the server tick or a map generation when a snapshot
depends on them. Events are acknowledged when your callback returns, not when a database commits: give purchases
an action id and make handlers idempotent.
