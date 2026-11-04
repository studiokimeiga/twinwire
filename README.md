# Twinwire

**Multiplayer networking for browser games.** One player session: WebSocket for what must arrive,
WebRTC datagrams for replaceable realtime state, and an optional WebTransport fast path. Twinwire picks a proven path when
the network allows it, falls back to the WebSocket the moment it doesn't, and keeps the player's session (and seat)
through dropped connections, app switches and Wi-Fi-to-cellular hand-offs. It comes with a lobby (room codes, quick
play, ready-up) and the netcode helpers an authoritative-server game needs.

```
npm install twinwire
npm install node-datachannel   # on the server, for WebRTC (optional: without it, WebSocket only)
```

[![CI](https://github.com/studiokimeiga/twinwire/actions/workflows/ci.yml/badge.svg)](https://github.com/studiokimeiga/twinwire/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/twinwire.svg)](https://www.npmjs.com/package/twinwire)
![license](https://img.shields.io/badge/license-MIT-blue.svg)

## Why

Browser games that want to feel good online hit the same wall: WebSocket is TCP, so one lost packet holds up every
packet behind it, and on a phone that's a stutter. WebRTC data channels can be unreliable and unordered like UDP, but
they're fiddly to set up, they fail on some networks, and a channel that says "open" isn't proof that packets get
through. Then there's everything around it: reconnecting without losing your place, rooms and invite codes,
interpolating other players, predicting your own.

Twinwire does that part, so the game can be the game:

- **Proven paths, one session.** WebSocket for the session; WebRTC and optional HTTP/3 WebTransport datagrams for state,
  used only while probes prove each path works *both ways*. Payload limits, path hysteresis and fallback keep the same
  player. WebRTC uses one UDP port on the server for every player.
- **Sessions that survive.** A dropped connection resumes the same session: same identity, same lobby seat, events
  replayed both ways. A page coming back from the background, or reloaded with a checkpoint, takes over cleanly.
- **Events at UDP speed.** Ordered, acknowledged JSON events go on the WebSocket *and* are mirrored on the datagram
  path, so a hit or a door usually lands at UDP latency with TCP as the guarantee.
- **State, latest wins.** Binary state streams that coalesce and expire instead of queueing, up to 64 KiB, with
  acknowledgements so you can send deltas against what each player actually has (`SnapshotHistory`, `diffEntities`).
- **A lobby.** Private rooms with codes, public quick play matched by mode and build, stable seats, host hand-off,
  ready-up with a countdown, kick, rate limits.
- **Netcode helpers.** Clock sync, snapshot interpolation with adaptive playback delay, client-side prediction and
  reconciliation, input redundancy, fixed-step simulation, interest queries, compact binary codecs.
- **Snapshot recovery.** `receiveState` resets or retains a stream's history according to policy and holds playback
  until usable fresh data arrives after reconnecting. A connected socket or retained clock cannot release it alone.
- **STUN/TURN** handed to each client by the server (coturn shared-secret credentials or Cloudflare's managed relay).
- **Browser coverage.** Tested in Chromium, Firefox and WebKit (Safari's engine) against the real server over WebRTC, on
  a bad network and with UDP blocked; see the release build for current bundle sizes.
- **Timing you can inspect.** Optional bounded metadata traces separate send queues, receipt, application, playback
  and render submission. Clock uncertainty stays visible; payloads and credentials are excluded.
- **Independent resources.** Bounded cancellable HTTP downloads with optional integrity checks keep world chunks out
  of the ordered gameplay-event sequence. Mixed-load scheduling protects state while preserving event order.

Your game keeps its rules, physics and rendering. Twinwire carries the bytes and the session; your server decides what
is true.

**3.0 uses wire generation 5:** upgrade clients and servers together. See
[transport, tracing and resource controls](docs/TRANSPORTS.md) for migration, optional HTTP/3 hosting and measured limits.

## Quick start

Start with the complete [standalone arena](examples/starter): install its locked dependencies, run
`npm start`, and open http://localhost:8787 in two tabs. Move with WASD/arrows or drag on touch screens, send a
reliable ping, then disconnect for two seconds and check that the player identity, position and score survive.
The client and server code is included; no undefined game-engine helpers or bundler are needed.

The [getting started guide](https://studiokimeiga.github.io/twinwire/guide/getting-started) includes a downloadable
project and deployment instructions. The [party example](examples/party) adds room codes, matchmaking, prediction
and interpolation. For an existing game, [named channels](docs/API.md#named-channels) preserve familiar message
names and room membership while making pause, fresh-state recovery and terminal expiry explicit. For Durable
Objects or another standard-WebSocket host, see [the Worker adapter](docs/API.md#worker--durable-object-host).

Your game still validates commands, owns physics and persistence, and decides when a complete snapshot or durable
board is usable. See [snapshot recovery](docs/API.md#snapshot-recovery) before attaching a renderer to raw callbacks.

## Examples

- **[Play the hosted starter](https://twinwire-demo.hak7alp.workers.dev/)**: a real private-invite arena, authoritative movement, ordered ping score and same-ID recovery over WebSocket. [Worker source](examples/starter-worker); no claim of durable transport storage.

- **[`examples/party`](examples/party)**: a complete little game. Quick play or a room by code, ready-up, then move
  around a shared arena and chat. Server-authoritative movement with client-side prediction and reconciliation, other
  players interpolated, inputs sent redundantly. About 300 lines. `npm run build && npm run example`, then open
  http://127.0.0.1:8790 in two tabs (`RTC=1` for WebRTC).
- **[`examples/arena`](examples/arena)**: the transport on its own, with live numbers (path, RTT, bytes).
  `npm run demo`.

The 2.1 release is used in **CS2**, **[kimu.nyc](https://kimu.nyc)** and **[Nocturne Keep](https://nocturnekeep.com)**: co-op story, maker rooms and a roguelike played
together, with the game's own code running each room's world on a $5 server.

## Documentation

**[studiokimeiga.github.io/twinwire](https://studiokimeiga.github.io/twinwire/)**: the guide, how each piece works (with
live demos that run the library in your browser), and the reference.

- [API](docs/API.md): every option and contract.
- [Architecture](docs/ARCHITECTURE.md): the wire protocol and the guarantees.
- [Adopting it in an existing game](docs/ADOPTING.md): a staged path, and what a real port looked like.
- [Operations](docs/OPERATIONS.md): hosting, the UDP port, TURN, budgets, health.
- [Transport and resource controls](docs/TRANSPORTS.md): WebTransport, timing traces, bulk requests and mixed traffic.
- [Validation](validation/STATUS.md): what was tested, where, and with what results.

## Develop

```sh
npm install
npm run check                 # build + unit and localhost integration tests
npm run test:native           # Node WebRTC client <-> native server: datagrams, fallback, recovery
npx playwright install chromium firefox webkit
npm run test:browser          # real browsers <-> native server (also IMPAIR=1, RTC=0)
npm run test:example          # the party example, played in three browsers
```

## Credit and citation

Twinwire was created by [Hakan Alpay](https://github.com/Kimeiga) and is maintained under [Studio Kimeiga](https://github.com/studiokimeiga).

For research, technical writing, or presentations that reference Twinwire, use GitHub's **Cite this repository** menu or the machine-readable [CITATION.cff](CITATION.cff). For games or tools that use Twinwire, a link to the [project](https://github.com/studiokimeiga/twinwire) is appreciated, though it is not a condition of the MIT license. Copies or substantial portions of Twinwire must retain the applicable copyright and license notice.

## Contributions and support

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Community support is provided on a best-effort basis; see [SUPPORT.md](SUPPORT.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

MIT licensed; see [LICENSE](LICENSE).
