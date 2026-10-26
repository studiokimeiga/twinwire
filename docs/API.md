# API and integration

All modules are ESM with TypeScript declarations.

| Import | For |
|---|---|
| `twinwire/client` | Browser: `GameClient`, `EventClient`, `createEventClient`, `LobbyClient`, `StateReceiver`, `BrowserRtcPeer` |
| `twinwire/server` | Node: `createGameServer`, `createEventServer`, `GameServer`, `GameSession`, `Lobby`, `Room`, `createNativeRtcFactory`, `turnCredentials`, `cloudflareTurn` |
| `twinwire/worker` | Standard WebSocket host: `SocketSessionServer`, `GameSession`; no Node/native dependencies |
| `twinwire/netcode` | Both: clock, interpolation, prediction, timing, snapshots, replication, codecs, spatial |
| `twinwire` | Both: the wire protocol and `Endpoint` |
| `twinwire/browser` | `dist/browser/twinwire.js` (also `.min.js`; ESM `.mjs` for `import`): client + lobby + netcode as `window.Twinwire` |

Browser code never imports the server entry. Node needs `ws`; WebRTC on the server needs `node-datachannel@0.33.x`.


## Named channels

For existing games with named JSON messages, use the same namespace and latest-stream mapping on both ends:

```js
// Node server
import {createEventServer} from 'twinwire/server';
const latest = {input:1, world:2};
const server = await createEventServer({
  port:8787, namespace:'arena-v1', latest, origins:['https://game.example'], resumeGraceMs:30_000,
});
server.onConnection(channel => {
  channel.join('example-room');
  channel.on('ping', () => channel.emit('pong', {ok:true}));
  channel.on('input', input => { /* validate, then update this player's simulation input */ });
  channel.onPause = () => { /* release held input, retain player and world */ };
  channel.onResume = () => { /* send a current complete world, retain the same seat */ };
  channel.onDisconnect(() => { /* explicit leave or expired session: remove the player */ });
});
await server.listen();

// Browser (separate file)
import {createEventClient} from 'twinwire/client';
const channel = createEventClient({url:'wss://game.example/connect',room:'arena-v1',latest,stateMaxAgeMs:250});
channel.on('pong', message => console.log(message));
channel.on('world', world => { /* validate and apply; return false if unusable */ });
channel.onReset = () => { /* clear old interpolation histories; called per mapped stream */ };
channel.onPause = () => { /* display reconnecting; preserve the game session */ };
channel.onConnect(() => { /* identity available on first join and each resume */ });
channel.net.bindPageLifecycle();
channel.emit('ping', {});
// In the render loop, advance world playback only while channel.ready('world').
```

Names absent from `latest` are ordered acknowledged events. Mapped names are JSON state streams: independent,
coalesced and disposable. Use a separate stream for each owner or independently replaceable value; relaying every
player's input under one state name would let one player overwrite another. Configured stream IDs are unique
integers 1–65535; at most 1024 mapped names. Both peers must use the same mapping and namespace. Treat a mapping
change as an application protocol change and deploy both ends together.

`new EventClient(options)` waits for `connect()`. `createEventClient(options)` starts in a microtask after callbacks
in the current task are installed. `on(name, handler)` replaces that name's previous handler. A state handler returning
`false` rejects readiness; returning `void` accepts valid JSON. Reject invalid snapshots explicitly. Recovery resets
histories by default and `ready(name)` uses the shared StateReceiver lifecycle and continuous age gate. Configure
`stateMaxAgeMs` for the game's state cadence (default 100 ms, allowed 0–30000); increasing it permits older playback,
so choose it deliberately. Raw binary streams, delta bases or coordinated groups should use `channel.net.receiveState`
directly, with stream IDs outside the named mapping.

Client `onPause` is temporary; `onResume` and `onConnect` run after a successful resume. Client `onDisconnect(handler)`
is terminal closed/lost only; it does not report temporary physical interruptions. There is one callback slot per
lifecycle hook. Register the final owning scene/controller when handing a connection between screens. The underlying
`net` exposes `whenOnline()`, status, lifecycle binding, checkpoints, testing drops and explicit new-session recovery.
An expired identity cannot silently replay old actions into a new player.

Server `onConnection` runs once per logical session; `channel.onPause` and `channel.onResume` run on that same channel.
Its handlers and rooms survive. `channel.join(room)`, `leave(room)` / `leave()`, `server.room(room).emit(name,data)`,
`channel.broadcast.emit(name,data)` (all other sessions) and `server.emit(name,data)` use those retained memberships.
At most 32 rooms per channel; room names are 1–128 characters. `channel.close()` ends the session. The server exposes
`channels` and the underlying `game`. Only expiry/explicit leave calls server `channel.onDisconnect(handler)`.

`emit` returns a sequence, or 0 when the underlying state/event cannot be queued. Event limits and callback retry
rules below still apply. Room/broadcast helpers have no aggregate delivery acknowledgement. An SDK event ACK means
the callback accepted it, not that a database transaction committed. Persist important commands in an application
queue and confirm the committed result separately.

## Worker / Durable Object host

`SocketSessionServer` implements the same protocol and GameSession delivery engine over standard WebSockets. It
supports browser GameClient recovery, ordered replay, takeover fencing and binary state without importing Node.
It uses WebSockets only. A Node server with native RTC is required for the datagram path.

The host selects ArrayBuffer binary delivery and replies to close frames on older Worker compatibility dates. The application owns routing/upgrades and must keep one host instance alive for its room. For a Cloudflare Durable
Object, create the host in the object's constructor; in fetch validate the route, Upgrade header and exact Origin,
create a WebSocketPair, call `server.accept()` on the accepted server socket, and return the other socket with status 101.
Pass the real request Origin and an authenticated/proxied client address; do not trust arbitrary forwarded headers
on an untrusted origin. A minimal accepted-socket integration:

```js
import {SocketSessionServer} from 'twinwire/worker';
const host = new SocketSessionServer({
  origins:['https://game.example'], resumeGraceMs:30_000, maxSessions:8, maxConnections:16,
  authenticate:({room}) => room==='private-room' ? 'validated-player-or-room-subject' : null,
  onSession(session, resumed) {
    if (!resumed) session.onEvent = command => { /* validate, enqueue a durable game command */ };
    // After durable recovery, send that player's current private game snapshot.
  },
  onDisconnect:session => { /* retain player during transport grace */ },
  onExpire:session => { /* apply the game's seat/AI expiry policy */ },
});
// In the application upgrade handler, after route/origin/auth checks:
// const pair = new WebSocketPair(); pair[1].binaryType='arraybuffer'; pair[1].accept();
// host.accept(pair[1], {origin:request.headers.get('Origin')||'', ip:trustedClientAddress});
// return new Response(null,{status:101,webSocket:pair[0]});
```

`allowsOrigin(origin)` lets the upgrade handler reject before accepting. Origins are exact strings or an explicit
predicate; wildcard entries are rejected. Missing Origin is rejected unless `allowMissingOrigin:true` is deliberately
enabled for trusted non-browser callers. Additional options: `endpoint`, `maxPerIp`, `maxSessionsPerIp`, `pumpHz`,
`heartbeatTimeoutMs`, `handshakeTimeoutMs`, `rateLimit:{messages,bytes}` and `onError`. `sessions` and `stats` are
observable; `endSession(session)` expires one; `close()` stops timers and ends them all.

Transport sessions, bearer tokens and replay queues are in memory. Object eviction/process restart creates a new
transport session. **No hibernation restoration or durable transport persistence is implemented.** Persist the game
world and private per-seat resume authorization separately. If the old transport is unavailable, explicitly create
a new one and authenticate the original game seat; never replay uncommitted old transport actions as new commands.
For a turn-based durable game, a reliable ready marker sent after the committed private snapshot can release its UI;
it need not invent a periodic state stream. The workerd integration gate exercises actual upgrades and recovery.

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
| `receiveState({stream, apply, reset?, playback?, resume?, maxExtrapolationMs?})` | Register a session-aware snapshot receiver. Its `ready` and `advance(dtMs)` wait for usable fresh state after every connect/resume. See below. |
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
| `rtcRetryMs` | 3000 | Wait before retrying a data channel that failed; doubles per consecutive failure up to 16×, at most 60 s. Bidirectional RTC proof clears the failure count. Duplicate resets for an already-stopped attempt are ignored. |
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
  rtc: await createNativeRtcFactory({ port: 8788, maxMessageSize: 64 * 1024 + 14 }),
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

## Snapshot recovery

`online` means a session is attached, not that its game state has recovered. A resumed session deliberately retains
its clock estimate; that estimate cannot tell whether new world data has arrived. Prefer a `StateReceiver` over
handwritten reconnect flags:

```js
const playback = new AdaptivePlayback(1000 / 30);
const timeline = new Timeline();
const snapshots = client.receiveState({
  stream: 0, playback, maxExtrapolationMs: 100,
  reset: () => timeline.clear(),
  apply: state => {
    const world = decodeSnapshot(state.data);
    if (!world) return false; // also false for a delta whose base is missing
    timeline.insert({ time: state.time, seq: world.tick, value: world });
    if (client.clock.synced) playback.observe(client.clock.serverTime(performance.now()), state.time);
    return true;
  },
});
function frame(dtMs) {
  const at = snapshots.advance(dtMs);
  if (at !== null) {
    const state = timeline.sample(at, interpolateWorld);
    if (state) draw(state.value);
  }
  // null: keep the last drawn view. Input sending and reliable events remain independent.
}
```

The default **`resume: 'reset'`** resets the supplied playback and calls `reset()` before application `onSession`
callbacks, on both new and resumed sessions. Register application-owned snapshot/delta histories in that callback.
**`resume: 'retain'`** keeps same-session histories and the playback policy, while still holding until fresh data;
new sessions always reset. A game that retains history need not maintain a second reconnect/freshness flag.

`apply` is synchronous and returns **true only for usable decoded state**. False, an omitted return, or an exception
cannot mark recovery ready. Exceptions reach `client.onError` without stopping raw `onState` observers. A failed
reset fails closed until a later successful reset. Do not also apply the same state in `onState`.

`ready` requires online transport, clock sync, and accepted state on the selected stream in the current connection.
The state header time must be within the supplied playback's delay plus `maxExtrapolationMs` (default 100 ms), and
not implausibly in the future relative to the clock uncertainty. Queued old state, unrelated streams, events and
rejected deltas cannot release it. A current header with unchanged/idle entities can. The timestamp describes the
snapshot on the server clock; an application must not repackage stale world data as a fresh snapshot. Epoch filtering
happens before `apply`. Freshness is checked continuously. Ordinary loss inside the configured delay/prediction budget
remains usable; if generation age exceeds that budget, `ready` becomes false and `advance` holds the cursor until
usable current data arrives. A busy socket carrying an old backlog cannot advance the declared replay time. The hold
retains histories and does not reset the session or block outbound input/events. Present-position staleness and
replay age can still grow during a hold: this does not reconstruct missing movement or reduce transport latency.

`advance(dtMs)` needs the supplied `playback`; it returns a render time or null and never advances its cursor while
recovering. Usable snapshot headers within the configured delay/prediction budget teach the delay policy during
recovery; the policy adapts even while the cursor is held, so a slower new route does not deadlock against the old
route's smaller buffer. States too old for even the maximum configured delay do not inflate that recovery estimate.
The game continues its own steady-state observations after recovery. A game with its own frame clock can use `ready`
instead, keeping its frame conversion and simulation.
There is one receiver per stream plus one filtered receiver for grouped streams, at most `endpoint.maxStreams`
(default 1024) total per client. Omit `stream` for a snapshot family split across several streams; `apply` must return
false for unrelated kinds/streams. One decoded family snapshot then releases that receiver, matching a shared
playback clock; it does not prove every independently replicated entity is fresh. Use separate receivers for worlds
whose recovery must be independent. Exact and filtered receivers can coexist; do not apply a payload twice. A latest-wins group packet must preserve every member whose current state that packet certifies: a partial
update can replace a pending update for a different member. Send complete current groups, retaining each entity's
accepted timestamp, or use independent streams/receivers for independent state. Partial reliable history can still
repair timelines without certifying whole-group freshness. A game may resample newly accepted history at its retained
render time during a hold; it must not advance that time until the receiver is ready.
`dispose()` removes a receiver and
permanently makes it unready. A receiver registered after connection starts its own recovery; use its reset callback
to clear any pre-existing application histories. It has no timers or sockets of its own.

This manages connection recovery, not game authority. Games still decode/validate their data, obtain a full snapshot
when a delta base is absent, and define teleports, collision, input replay and persistence. Raw `onState` and
`AdaptivePlayback` remain available for adapters that own their complete lifecycle.

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
playback (`playback.reset()`, the timelines) in `onSession` when `resumed` is false. `receiveState` handles this lifecycle
and the fresh-data gate when given a playback and a reset callback. `AdaptivePlayback` also starts over
by itself if the clock jumps back by more than a second, rather than freezing until the new clock catches up.
`AdaptivePlayback.updateDelay(dtMs)` updates only the delay policy without moving the cursor; `advance` normally does
both. `StateReceiver.advance` uses that separation during recovery, with one adaptation per render frame.

**Sub-tick input (optional).** `SubtickInputBuffer<T>` records input-state transitions with local monotonic
timestamps and `take(startMs, endMs, maxPerTick?)` emits ordered fractions inside each fixed-step input command.
Events exactly at `endMs` belong to the next command. It snapshots input values, bounds pending transitions,
rejects nonmonotonic timestamps and refuses to silently shift old events after a skipped tick or CPU stall.
Call `reset()` on a deliberate simulation discontinuity. DOM `event.timeStamp` and tick boundaries must use the
same local clock. This is client-side input timing, not a trusted timestamp.

`replaySubtick(initial, transitions, tickMs, step, change?)` calls `step(held, dtMs, fromFraction, toFraction)`
between transitions, `change(before, after, fraction)` at each edge, and returns the final held state.
All fractions must be sorted in [0, 1); malformed input fails before any callback. The validated event schedule is copied before callbacks, so a callback cannot rewrite later fractions. The application defines
button meanings, physics, aim interpolation, and serialization (for example encode commands as the payload
of `encodeInputs`). These helpers neither change Twinwire's wire format nor change the server tick rate.

**Server rewind selection (optional).** `selectRewindTime(requestedViewTimeMs, nowMs,
expectedViewTimeMs, maxRewindMs, toleranceMs)` returns `{timeMs, source, reason}`.
It accepts a client-requested view time only within the hard history window and the tolerance of an
**independently server-derived** estimate; otherwise it selects the bounded server estimate. A client
ACK/timestamp cannot be used as that trusted estimate, and RTT/2 alone is not measured one-way latency.
Games must account for input-command age, network jitter, interpolation, and snapshot delivery history,
then independently validate the shot, shooter position, and hitboxes. A large tolerance still permits
the client to choose a time within that tolerance. No default fairness policy or cap is imposed.

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
