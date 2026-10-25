# Operations

<p class="lede">Running a Twinwire server in production: TLS and the UDP port, origins and proxies, TURN, what to watch,
and what a $5 server can and can't do.</p>

## Layout

The usual shape is one Node process per game on a small VPS:

- **Static files** (the game's page and assets) stay on your existing host or CDN.
- **Caddy** (or nginx) on the VPS terminates HTTPS on port 443 and proxies the WebSocket path (`/connect`) to the Node
  process on `127.0.0.1`.
- **The UDP port** for WebRTC is reached directly, not through the proxy. Open it in the firewall. An HTTP CDN won't
  forward it.

```txt
play.mygame.com {
  reverse_proxy /connect 127.0.0.1:8787
}
```

```js
const server = await createGameServer({
  host: '127.0.0.1', port: 8787,
  origins: ['https://mygame.com'],
  trustProxy: true,                                   // Caddy is on this machine: read X-Forwarded-For
  rtc: await createNativeRtcFactory({ port: 8788 }),  // open UDP 8788 in the firewall
  http: (req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(server.metrics())); return; }
    res.writeHead(404); res.end();
  },
});
```

A page served over HTTPS can only open a secure WebSocket: never expose plain `ws://` to it. Use a distinct UDP port
for each game process on the same host: connections are multiplexed within a process, not across processes. On a VPS
behind 1:1 NAT (some clouds give the instance a private address), set `publicIp` on the native factory so its
candidates carry the public address.

Run the process as an unprivileged user. If you configure WebRTC, let startup fail when `node-datachannel` is
missing, rather than quietly running WebSocket-only: `createNativeRtcFactory` throws for exactly that reason.

## Origins, proxies and abuse

- **Origins**: list the exact origins your pages are served from, or pass a predicate. Origin is not authentication:
  it stops other websites from using your server from their pages, nothing more.
- **Authentication**: with accounts, `authenticate` returns a stable subject, and is checked again on every resume.
- **Behind a proxy**, every connection comes from `127.0.0.1` unless `trustProxy` is on; per-address limits would
  then treat all players as one. Only the last `X-Forwarded-For` hop is trusted, and only when the peer is local.
- **Limits**: per-connection message and byte rates (300 messages and 256 KiB a second by default), sessions,
  connections and connections per address, rooms per address per hour. Validate every event and input your game
  receives.
- **Resume tokens** are bearer secrets. Checkpoints contain one: `sessionStorage`, never a URL.

## STUN and TURN

Players reach your server's UDP port directly. The server has a public address, so ordinary home, office and cellular
NAT need no relay. Some networks block UDP outright (some corporate and school Wi-Fi, some hotel portals): those
players stay on the WebSocket, which works wherever HTTPS does. TURN helps the networks in between, which block UDP to
arbitrary ports but allow it to a relay, or allow TURN over TLS on 443.

Hand clients their ICE servers from the server, so you can rotate them without a new build:

```js
import { turnCredentials, cloudflareTurn } from 'twinwire/server';

// your own coturn (use-auth-secret, static-auth-secret=...): credentials expire after ttlSeconds
iceServers: session => [
  { urls: 'stun:turn.mygame.com:3478' },
  turnCredentials({ secret: process.env.TURN_SECRET, user: session.id.slice(0, 8),
    urls: ['turn:turn.mygame.com:3478?transport=udp', 'turns:turn.mygame.com:443?transport=tcp'] }),
],
// or Cloudflare's managed relay (anycast, UDP/TCP/TLS 443), cached until shortly before expiry
iceServers: cloudflareTurn({ keyId: process.env.CF_TURN_KEY_ID, apiToken: process.env.CF_TURN_TOKEN }),
```

Relayed traffic costs relay bandwidth (your VPS's for coturn, Cloudflare's pricing otherwise). Add TURN once you've
measured players stuck on the WebSocket (`server.metrics().ws`) who would benefit.

## What to watch

`server.metrics()` gives sessions, connections, how many are on rtc and ws, bytes each way, pending events, protocol
errors, rate limiting, resumes and expiries. Serve it on `/health` (it contains no tokens or player data, but it does
expose counts). Beyond that, watch:

- process memory and CPU, event-loop delay, and your simulation's tick time;
- states expired and coalesced (`session.endpoint.stats`): a sign the budget or the link is too small;
- resume failures, and how many players fall back to the WebSocket;
- total network transfer, and what your provider bills.

Sessions live in memory. A restart or deploy loses them, so every player starts a new session: make sure your game
can send a full state to a fresh client, and that actions are idempotent across restarts.

## The $5 server

Twinwire has no hosting fees and adds little overhead, but it can't make continuous traffic free. Whether a $5 VPS
carries your game depends on your simulation's cost, how many players are on at once, how much each one receives, and
your provider's transfer allowance.

As arithmetic, not a quote: 50 players receiving 40,000 bytes a second for 720 hours is 5,184 GB. With a 1,000 GB
allowance and $0.01 per GB over it, that's about $47 a month before protocol overhead. The repository's calculator
does this sum with your numbers:

```sh
npm run budget -- --base 5 --included-gb 1000 --overage 0.01 --bytes 12000 --players 5 --hours 100 --overhead 0.20
```

The ways to get there are the ones on these pages: send each player only what is near them
([interest](/how/interest)), only what changed ([deltas](/how/deltas)), at a modest rate, and nothing when nothing
moves.

## Measuring

Measure with your real game, not a lab. Run a staging VPS with the memory and CPU you intend to buy, and around 50
clients from another machine, busy and idle separately. Impair the network at the operating system level on machines
you control to test both paths for real; the built-in `impair` option is application-level and doesn't model TCP's
behaviour. For input-to-screen latency, use two physical devices, or a camera.
