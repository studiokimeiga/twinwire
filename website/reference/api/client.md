# twinwire/client

The browser's side: one `GameClient` per page, and a `LobbyClient` on top of it for rooms.

## GameClient

```ts
import { GameClient } from 'twinwire/client';

const client = new GameClient({
  url: 'wss://game.example.com/connect',
  room: 'mygame',                 // a namespace the server sees; rooms with codes come from the lobby
  auth: { name: 'WREN', build },  // any JSON: checked by the server's authenticate hook, and kept as session.hello
  rtc: {},                        // the default. false: WebSocket only. { iceServers } overrides the server's list
  endpoint: { bytesPerSecond: 32 * 1024 },
});
```

### Options

| Option | Default | |
|---|---|---|
| `url` | required | `ws:` or `wss:` |
| `room` | required | 1 to 64 characters of `A-Z a-z 0-9 _ : . -` |
| `auth` | `null` | Any JSON. Sent with every hello, so the server sees it again on resume |
| `rtc` | `{}` | `false` for WebSocket only, or an `RTCConfiguration`. With `iceServers`, those replace the server's |
| `endpoint` | | [Endpoint options](/reference/api/server#endpoint-options) for this client |
| `checkpoint` | | Resume a session saved by `checkpoint()` (see below) |
| `impair` | | `{ lagMs, jitterMs, loss, duplicate }` on this client's sends, and asked of the server (honoured only with `allowImpairment`). `lagMs` is one way. For testing |
| `reconnectBaseMs`, `reconnectMaxMs` | 200, 8000 | Reconnect backoff: doubles from the base, randomised, up to the max |
| `heartbeatTimeoutMs` | 8000 | A connection silent this long is replaced |
| `rtcRetryMs` | 3000 | First WebRTC retry after a failure; doubles up to 16× (and never more than 60 s) |
| `rtcConnectTimeoutMs` | 8000 | Give up on a WebRTC attempt that hasn't proven itself by then |
| `pumpHz` | 60 | How often the client sends queued messages |
| `websocket` | `url => new WebSocket(url)` | Supply your own WebSocket (tests, other runtimes) |

### Members

| Member | |
|---|---|
| `connect()` | Start joining (or resuming) and sending. Throws after session loss: call `newSession()` |
| `whenOnline()` | Resolves when online (at once if already), rejects if the session is lost or closed first |
| `status`, `onStatus(s)` | `idle`, `connecting`, `online`, `paused`, `closed`, `lost` |
| `transport`, `onTransport(t)` | `rtc` (datagrams proven both ways), `ws`, `none` |
| `id`, `onSession({ id, resumed })` | The session's identity. `resumed: false` means a brand-new session: reset game state |
| `onSessionLost({ pendingEvents, reason })` | Expiry, kick, takeover by another tab, authentication or protocol rejection. Retrying stops |
| `sendEvent(json)` | Ordered, acknowledged; returns its seq. Throws when the outbox is full (512 events or 1 MiB) or the event is over 64 KiB |
| `onEvent(data, seq)` | Each event exactly once, in order. Throwing means "not accepted": the event comes again |
| `sendState(stream, bytes, { ttlMs, priority, ack }?)` | Latest wins per stream. Returns the seq, or 0 before the session is online and the clock synced |
| `onState({ stream, seq, time, data, via })` | `time` is the sender's server-clock estimate: never trust it for authority |
| `onStateAck(stream, seq)` | For states sent with `ack: true`: the newest the peer has seen |
| `onError(error)` | Problems that don't end the session (a callback that threw, a WebRTC failure) |
| `clock` | `synced`, `rttMs`, `uncertaintyMs`, `serverTime(performance.now())` |
| `iceServers` | The STUN/TURN servers the server suggested in its welcome |
| `pause()`, `resume()` | Close and reopen the connection, keeping the session |
| `reconnectNow()` | Skip the backoff wait (the network came back) |
| `simulateDrop()` | Drop the connection as a network failure would; the session resumes by itself. For tests |
| `newSession()` | Drop the old session and its unsent events; get a new identity |
| `close()` | Leave for good: the server ends the session at once |
| `flush()` | Send what is queued now instead of at the next pump |
| `checkpoint()` | `{ url, room, token, id, events }`, or null. Holds a bearer token: never put it in a URL |
| `bindPageLifecycle({ hiddenPauseMs, wakeCheckMs })` | Pause on `pagehide` or after 20 s hidden; on return, resume, or replace a socket silent for 1.5 s; reconnect at once on `online`. Returns a function that unbinds |
| `intercept(fn)`, `on('session' \| 'lost', fn)` | Extra listeners for helpers such as `LobbyClient`. Each returns a function that removes it |
| `endpoint.stats` | Bytes, states sent and received, stale, expired and coalesced states, `eventsViaDatagram`, `datagramRttMs`, and more |

Callbacks should be short. Don't throw from `onEvent` after side effects: a throw means the event wasn't accepted, and
the same event is offered again, in order, about 100 ms later. A throw from `onState` or `onStateAck` drops that one
message. Either way the connection carries on and the error goes to `onError`.

## LobbyClient

```ts
import { LobbyClient } from 'twinwire/client';

const lobby = new LobbyClient(client);             // optional second argument: request timeout (20 s)
const room = await lobby.create({ mode: 'night', visibility: 'private', maxMembers: 4, meta: { build } });
await lobby.join('KQXT');                           // case-insensitive
await lobby.quickPlay({ mode: 'night', match: { build }, create: { maxMembers: 4 } });
await lobby.setReady(true); await lobby.setName('WREN'); await lobby.setMeta({ skin: 2 });
await lobby.kick(2); await lobby.leave();
```

| Member | |
|---|---|
| `create(request)` | `{ mode, visibility, maxMembers, meta, name, memberMeta, init }`. `init` goes to the server's `onCreate` and is never shown to other members |
| `join(code, { name, memberMeta }?)` | Rejects at once if the code isn't a code |
| `quickPlay({ mode, match, name, memberMeta, create })` | `match`: only rooms whose meta has these exact values. `create`: used when none fits |
| `setReady`, `setName`, `setMeta`, `kick(seat)`, `leave()` | Each resolves with the new room view |
| `room`, `onRoom(room)` | The current `RoomView` (or null), on every change |
| `onLeft(reason)` | Left without asking: kicked, replaced, closed, expired, new session |
| `me`, `isHost` | Your own member view, and whether you are host |
| `countdownMs()` | Milliseconds until the ready countdown ends, on the server clock, or null |
| `dispose()` | Stop listening to the client |

Requests reject with the server's message: `no room called ZZZZ`, `that room is full`, or your `canJoin` text.

```ts
interface RoomView {
  code: string; mode: string; visibility: 'public' | 'private'; phase: string; maxMembers: number;
  meta: Record<string, Json>;
  you: number;                       // your seat
  members: { seat: number; name: string; ready: boolean; connected: boolean; host: boolean; meta: Record<string, Json> }[];
  countdownEndsAt: number | null;    // server clock (ms); compare with client.clock.serverTime()
}
```

Lobby traffic uses events with a `$lobby` key (`LOBBY_KEY`); your `onEvent` never sees them.

## BrowserRtcPeer

The browser half of the WebRTC data channel: unordered, no retransmits, labelled `twinwire`. `GameClient` creates and
manages it; you only need it to build a client of your own on `Endpoint`.
