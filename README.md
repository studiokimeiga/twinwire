# Twinwire

**Multiplayer networking for browser games.** One player session, two wires: a WebSocket for what must arrive, and
WebRTC datagrams (UDP-like: unordered, no retransmits) for what must arrive *fast*. Twinwire picks the fast wire when
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

- **Two wires, one session.** WebSocket for the session; a WebRTC data channel for state, used only while probes prove
  it works *both ways*. Fallback within ~1.5 s, RTC retried with backoff, one UDP port on the server for every player.
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

Your game keeps its rules, physics and rendering. Twinwire carries the bytes and the session; your server decides what
is true.

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

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

MIT licensed.
