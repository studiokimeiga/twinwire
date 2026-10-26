# Named channels

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
