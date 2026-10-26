# VPS operation and the $5 target

## Hosted validation

The networking workflow runs core/native gates on Node 22 and 24, gives each browser engine its own standard Ubuntu
runner, and runs two independent ten-minute lifecycle/hostile-client soaks alongside them. A PR no longer repeats
the same suite for both its branch push and its pull-request event: pushes run on main, PR updates run the PR workflow.
New commits cancel obsolete runs for that ref. Native and browser jobs remain separate from the long soak.

The workflow's manual dispatch accepts 10, 30 or 60 minutes. Each soak uses 48 honest and 6 hostile WebSocket clients
in a worker thread, checks action ordering and cleanup, and records revision, Node, CPU, memory, source hashes and
raw logs. Artifacts are retained for three days. A failed or cancelled run is not a completed soak. The existing
randomized harness does not provide an identical seeded replay schedule.

These jobs use standard hosted runners. Public-repository standard runner minutes are free; artifact storage has a
separate allowance. Personal Pro does not upgrade an organization account. Private game repositories consume their
owner's included minutes and should use bounded manual long runs rather than duplicating every development edit.
[GitHub billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) and
[runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) describe the current terms.

Independent VMs reduce local CPU contention and provide parallel feedback. A ten-minute test still requires ten
minutes of exposure. Hosted VM timing is its own baseline: it does not establish physical-device behavior, cellular
handoffs, TURN reachability, separate-machine capacity or a production VPS performance budget. Keep those checks
in an environment that actually reproduces them.

The package has no hosting fees. It does not impose a provider bill cap, buy servers, or guarantee that a $5 VPS can run every game. Simulation cost, concurrency, entity density, activity hours, transfer allowance, and public-IP costs determine that result. A New Jersey server can be a test baseline for nearby players; it cannot provide equally low latency to players worldwide.

## Budget before deployment

Use your actual provider terms. The calculator's defaults are illustrative, not a live Vultr quote:

```sh
npm run budget -- --base 5 --included-gb 1000 --overage 0.01 \
  --bytes 12000 --players 5 --hours 100 --overhead 0.20
```

`--players` is average concurrency during the specified active hours, not registered users. `--bytes` is observed encoded downlink bytes/sec/player, not an estimated schema size alone. `--overhead` estimates additional network framing. The calculator does not include backups, VAT, managed TLS services, relays, logs, storage, or transfer used by other processes.

Arithmetic example, not a plan recommendation: 50 players at 40,000 bytes/sec for 720 hours generate 5,184 GB of application payload. With a hypothetical $5 base, 1,000 GB allowance, and $0.01/GB overage, that is $46.84 even before protocol overhead. A transport library cannot make continuous traffic free.

To approach the target, send compact state only to relevant viewers, reduce idle updates, batch small entity records, bound rates, and leave static assets on the existing CDN. The default endpoint budget is a starting cap, not an established visual-quality optimum. Event/control overhead and transport accounting still need measurement.

## Deployment templates

`deploy/Dockerfile`, `deploy/Caddyfile`, and `deploy/twinwire-demo.service` are templates, not tested deployments. They run the arena as a lab; replace the command with your actual room entry point after integration. Nothing here provisions infrastructure.

Suggested layout: client/static assets through the existing host; a conventional Node process on the VPS; local Caddy terminates HTTPS/WSS on 443 and proxies `/connect`; WebRTC connects directly to a public UDP socket. The UDP endpoint must be reachable independently of the HTTP proxy. Do not assume a standard HTTP CDN forwards this UDP port.

A browser on HTTPS requires a secure WebSocket endpoint. Configure exact allowed origins. Keep admin/health endpoints restricted as appropriate. The sample `/health` intentionally contains no tokens or player data, but does expose process counts and memory.

The native server uses one UDP port for its connections. Use a distinct UDP port for each project/process on the same host. Muxing within a process does not let unrelated processes safely share the same port. The optional `publicIp` setting only rewrites IPv4 host candidates; it does not set up NAT or port forwarding. Test IPv6-only client paths and NAT64 explicitly before claiming them supported.

Example environment for a staging lab:

```sh
HOST=127.0.0.1
PORT=8787
ALLOWED_ORIGINS=https://game.example.com
RTC=1
RTC_PORT=8788
# Set only when candidate rewriting is required by your network layout:
# RTC_PUBLIC_IP=203.0.113.7
```

Serve it behind TLS, allow the configured UDP port through the relevant firewall, and test from outside the VPS. Do not expose plain WS from an HTTPS page. Do not advertise example addresses as working endpoints.

## Resource and security operations

Run the process as a dedicated unprivileged user. Restrict writable paths; back up durable game data separately. Process restart loses the transport's in-memory sessions/outboxes, so the app must implement full resync and action idempotency across restarts. Database-backed transport resumption is not implemented.

Per-IP connection limits use the actual TCP peer address. Behind Caddy, all peers may be attributed to the proxy. Set an appropriate cap and rate limit at the proxy; never blindly trust client-supplied `X-Forwarded-For` headers.

Monitor process RSS/CPU, event-loop p99, simulation tick p99, queued bytes, state expiry/coalescing, pending events, session resume failures, datagram success/fallback/retry, total NIC transfer, and provider-billed egress. Server transport counters do not include full network overhead or all handshake traffic.

Keep UDP optional, but do not hide a missing native dependency. `RTC=1` fails startup if native support is unavailable. A connection that uses WS fallback is a valid compatibility result, not proof that the UDP deployment works.

## Measurement plan

Use a staging VPS with the intended memory/CPU allocation. Run 50 clients from a different machine with your actual game simulation and visible-entity density. Record busy and idle behavior separately. Do not infer capacity from the localhost lab's server+clients combined CPU.

Use OS-level network impairment on machines you control to test both protocols with real transport behavior. The deterministic test harness injects application-level drops/reordering and does not model actual TCP congestion control. Never label that as cellular measurement.

Use two physical devices for remote input-to-pixel latency, or a calibrated camera/capture method. Report measurement error, render buffering, and clock assumptions. A snapshot's interpolation error at a delayed timestamp is not its error relative to the other player's present position.

## STUN and TURN

Players reach your server's UDP port directly: the server has a public address, so the browser's connectivity checks
arrive from wherever the player is and no relay is needed for ordinary home, office or cellular NAT. Some networks
block UDP outright (some corporate and school Wi-Fi, some hotel captive portals); those players stay on the
WebSocket, which works everywhere HTTPS does. TURN helps one more group: networks that block UDP to arbitrary ports
but allow it (or TURN over TLS on 443) to a relay.

Give clients ICE servers from the server so you can rotate them without a new build:

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

Relayed traffic counts against the relay's bandwidth (your VPS's for coturn, Cloudflare's pricing otherwise). Add
TURN once you've measured players stuck on the WebSocket path (`server.metrics().ws`) who would benefit.

On a VPS behind 1:1 NAT (some clouds give the instance a private address), set `publicIp` on the native factory so
its host candidates carry the public address, or add a STUN server to the factory's own `iceServers`.

## Health endpoint

`server.metrics()` returns sessions, connections, how many are on rtc vs ws, bytes each way, pending events and
protocol errors: serve it from your `http` handler on `/health`.


## Releases without an interactive npm login

The `release.yml` GitHub Actions workflow runs on `v*` tags, checks the version,
builds and tests, then publishes with npm trusted publishing (OIDC) and creates
the GitHub release. It runs on GitHub-hosted runners with Node 24 and
`id-token: write`; no `NPM_TOKEN` secret is required. It must use npm 11.5.1 or newer.

One-time package-owner setup: authorize GitHub repository `studiokimeiga/twinwire`,
workflow filename `release.yml`, with direct `npm publish` allowed. Leave the
optional environment blank because this workflow does not use an environment.
Account authentication or a passkey may be required when creating that trust.
After configuration, verify an actual tagged release publishes successfully;
editing a workflow alone does not establish npm-side trust. New trust must be
validated by a successful publish within two days.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
