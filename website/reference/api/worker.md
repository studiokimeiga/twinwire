# Worker / Durable Object host

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
