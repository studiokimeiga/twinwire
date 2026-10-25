# twinwire/server

Node 22 or newer. The room server: sessions, the lobby, WebRTC, and TURN credentials.

## createGameServer

```ts
import { createGameServer, createNativeRtcFactory, turnCredentials } from 'twinwire/server';

const server = await createGameServer({
  host: '127.0.0.1', port: 8787, origins: ['https://game.example.com'],
  rtc: await createNativeRtcFactory({ port: 8788, maxMessageSize: 64 * 1024 + 22 }),
  iceServers: session => [turnCredentials({ secret: process.env.TURN_SECRET, urls: 'turn:turn.example.com:3478', user: session.id })],
  trustProxy: true, resumeGraceMs: 90_000,
  authenticate: ({ auth, room, resuming, ip }) => validBuild(auth) ? 'anon' : null,
  endpoint: { bytesPerSecond: 48 * 1024 },
});
await server.listen();   // resolves with the port
```

| Option | Default | |
|---|---|---|
| `origins` | required | Exact page origins, or a predicate `(origin) => boolean`. A `'*'` is refused |
| `allowMissingOrigin` | false | Let clients without an `Origin` header in (non-browser clients) |
| `port`, `host`, `path` | 0, `127.0.0.1`, `/connect` | Where to listen, and the WebSocket path |
| `rtc` | none | A WebRTC factory, usually `createNativeRtcFactory(...)`. Without it: WebSocket only |
| `iceServers` | `[]` | An array, or `(session) => array \| Promise`, sent in each welcome |
| `authenticate` | | `({ room, auth, resuming, ip }) => subject \| null`. Return a stable account subject, or null to refuse. Checked again on resume, and a resumed session must have the same subject |
| `trustProxy` | false | Take the client address from the last `X-Forwarded-For` hop when the peer is a local proxy |
| `resumeGraceMs` | 90 000 | How long a dropped session (and its lobby seat) waits |
| `heartbeatTimeoutMs` | 15 000 | A connection silent this long is closed |
| `handshakeTimeoutMs` | 5 000 | A connection that hasn't said hello by then is closed |
| `maxSessions`, `maxConnections`, `maxPerIp` | 256, 512, 32 | |
| `rateLimit` | `{ messages: 300, bytes: 256 KiB }` | Per connection, per second, both transports together |
| `allowImpairment` | false | Honour a client's `impair` request. Development only |
| `endpoint` | | [Endpoint options](#endpoint-options) for every session |
| `onSession(session, resumed)`, `onDisconnect(session)`, `onExpire(session)` | | Lifecycle callbacks; `on()` adds more listeners |
| `onError(error)` | | Problems that don't stop the server |
| `http(req, res)` | 404 | Your handler for plain HTTP requests on the same port (a `/health` route, static files) |

## GameServer

| Member | |
|---|---|
| `listen()` | Start listening and pumping; resolves with the port |
| `sessions` | Map of id to `GameSession` |
| `on('session' \| 'disconnect' \| 'expire', fn)` | Extra listeners; each returns a function that removes it |
| `endSession(session, reason)` | Kick: the client gets `onSessionLost(reason)` and doesn't reconnect into it |
| `broadcast(room, json)` | An event to every session that said hello with that `room`. Returns `{ queued, rejected }` |
| `metrics()` | Sessions, connections, how many on rtc and ws, bytes each way, pending events, protocol errors, resumes, expiries. For `/health` |
| `addressOf(req)` | The address the per-address limits use |
| `close()` | Close every connection and stop |

## GameSession

| Member | |
|---|---|
| `id`, `room`, `subject` | Identity: the hello's room namespace, and your `authenticate` result |
| `connected`, `transport`, `epoch` | Whether a connection is up, on `rtc` or `ws`, and which connection it is |
| `ip` | The address of the current (or last) connection |
| `hello` | The client's latest `auth` JSON (names, build ids). Validate before use |
| `data` | Yours |
| `sendEvent(json)`, `sendState(stream, bytes, options?)` | As on the client |
| `onEvent`, `onState`, `onStateAck` | As on the client. A lobby takes `onEvent` and `onState` over |
| `endpoint` | The session's `Endpoint`, with its `stats` |

## Lobby

```ts
import { Lobby } from 'twinwire/server';

const lobby = new Lobby(server, {
  maxMembers: 4, codeLength: 4, emptyCloseMs: 30_000,
  joinablePhases: ['lobby', 'playing'],          // join by code mid-game (drop-in)
  quickPlayPhases: ['lobby'],                    // quick play only into rooms still waiting
  ready: { countdownMs: 3000, minMembers: 1 },   // or false
  evictDisconnected: true, allowHostKick: true, maxRoomsPerIpPerHour: 30,
  clientMetaKeys: ['skin'],                      // member meta keys clients may set (default: any)
  canCreate: (session, request) => null,         // or an error message
  canJoin: (room, session, request) => room.meta.build !== session.hello?.build ? 'A NEW VERSION IS OUT' : null,
});
```

| Option | Default | |
|---|---|---|
| `maxMembers` | 4 | Seats per room unless a request asks for fewer (at most 64) |
| `codeLength` | 4 | Room code length (3 to 12), from an alphabet without I and O |
| `emptyCloseMs` | 30 000 | A room with nobody left closes after this long; a join by code cancels it |
| `maxRooms` | 500 | |
| `maxRoomsPerIpPerHour` | 30 | |
| `joinablePhases` | `['lobby', 'playing']` | Phases a code can join |
| `quickPlayPhases` | `['lobby']` | Phases quick play may drop a player into |
| `evictDisconnected` | true | When a room is full, free the seat of whoever has been disconnected longest |
| `ready` | `{ countdownMs: 3000, minMembers: 1 }` | Once every connected member is ready (and at least `minMembers`), count down and start. `false`: no ready-up |
| `allowHostKick` | true | |
| `clientMetaKeys` | any | Member meta keys a client may set. Keys your server sets stay out of this list |
| `canCreate(session, request)` | | Return an error message to refuse |
| `canJoin(room, session, request)` | | Return an error message to refuse; used for codes and quick play |

The lobby owns each session's `onEvent` and `onState`. Its callbacks, with `room` and `member` null for a session that
isn't in a room: `onCreate(room, creator, request)`, `onJoin(room, member)`, `onLeave(room, member, reason)`,
`onDisconnect(room, member)`, `onReconnect(room, member)`, `onStart(room)`, `onClose(room, reason)`,
`onEvent(room, member, data, session)`, `onState(room, member, state, session)`, `onError(error)`.

Members: `rooms` (by code), `createRoom({ mode, visibility, maxMembers, meta })` (a room on the server's own
initiative), `roomOf(session)`, `memberOf(session)`, `dispose()`.

**Room**: `code`, `mode`, `visibility`, `phase`, `meta`, `data` (yours), `members` (by session id), `host`,
`memberAt(seat)`, `connectedCount`, `countdownEndsAt`, `broadcast(json, except?)`, `send(member, json)`,
`setPhase(phase)` (`'lobby'` clears ready), `setMeta(patch)`, `setVisibility(v)`, `start()` (skip the countdown),
`close(reason)`.

**Member**: `session`, `room`, `seat` (stable), `joinedAt`, `name`, `ready`, `connected`, `disconnectedAt`, `meta`,
`data` (yours).

A member keeps its seat while disconnected, until its session expires. Seats are the lowest free number. The first
member is host; when the host drops or leaves, the earliest-joined connected member takes over.

## WebRTC

```ts
const rtc = await createNativeRtcFactory({ port: 8788, publicIp: '203.0.113.7' });
```

`createNativeRtcFactory({ port, publicIp, bindAddress, iceServers, maxMessageSize })` loads `node-datachannel` and
fails loudly if it is missing. Every connection shares the one UDP `port` (ICE mux). `publicIp` rewrites IPv4 host
candidates for a server behind 1:1 NAT; `maxMessageSize` (64 KiB + 22) should match the endpoints' `maxStateBytes`
plus the 22-byte header. `nativeRtcFactory(module, options)` does the same with a module you've loaded yourself.

## TURN

```ts
turnCredentials({ secret, urls, user, ttlSeconds })      // coturn use-auth-secret: one IceServer, valid ttlSeconds (3600)
cloudflareTurn({ keyId, apiToken, ttlSeconds })          // Cloudflare's relay: () => Promise<IceServer[]>, cached
```

Both are made to be returned from `iceServers`, so secrets stay on the server and clients get short-lived credentials.

## Endpoint options

Both sides of a session run an `Endpoint`. Pass these as `endpoint` to the server or the client; both ends should agree
on `maxStateBytes`.

| Option | Default | |
|---|---|---|
| `bytesPerSecond`, `burstBytes` | 32 KiB, max(rate / 2, 16 KiB) | Budget for states and events. A message bigger than the burst goes once the bucket is full |
| `maxBufferedBytes` | 64 KiB | Socket backpressure |
| `maxStateBytes` | 64 KiB | Largest state (at most 256 KiB) |
| `datagramStateBytes` | 8 KiB | Bigger states use the WebSocket even when datagrams are up |
| `datagramEvents` | true | Mirror events on the datagram path |
| `stateAckIntervalMs` | 50 | How often state acknowledgements go back |
| `probeIntervalMs`, `probeTimeoutMs` | 250, 1500 | Datagram proof: how often to probe, and how long without a reply before giving the path up |
| `maxStreams` | 1024 | |
| `events` | `{ maxEvents: 512, maxBytes: 1 MiB, maxEventBytes: 64 KiB }` | The event outbox |
| `impair` | | Simulated trouble on this endpoint's sends, for testing |
