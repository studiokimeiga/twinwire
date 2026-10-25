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
- **STUN/TURN** handed to each client by the server (coturn shared-secret credentials or Cloudflare's managed relay).
- **Every browser.** Tested in Chromium, Firefox and WebKit (Safari's engine) against the real server over WebRTC, on
  a bad network and with UDP blocked; 15 KB gzipped in the browser.

Your game keeps its rules, physics and rendering. Twinwire carries the bytes and the session; your server decides what
is true.

## Quick start

**Server** (Node 22+)

```js
import { createGameServer, createNativeRtcFactory, Lobby } from 'twinwire/server';

const server = await createGameServer({
  port: 8787,
  origins: ['https://mygame.com'],
  rtc: await createNativeRtcFactory({ port: 8788 }),     // one UDP port for everyone (needs node-datachannel)
});
const lobby = new Lobby(server, { maxMembers: 4, ready: { countdownMs: 3000 } });

lobby.onCreate = room => { room.data = createWorld(); };
lobby.onEvent = (room, member, msg) => room?.data.command(member.seat, msg);   // validate, then apply
lobby.onState = (room, member, input) => room?.data.input(member.seat, input.data);
setInterval(() => {
  for (const room of lobby.rooms.values()) {
    room.data?.step();
    for (const m of room.members.values()) if (m.connected) m.session.sendState(0, room.data.snapshotFor(m.seat));
  }
}, 1000 / 30);

await server.listen();
```

**Browser** (with a bundler: `twinwire/client` and `twinwire/netcode`; or a script tag with `twinwire/browser`,
which defines `window.Twinwire`)

```js
import { GameClient, LobbyClient } from 'twinwire/client';

const net = new GameClient({ url: 'wss://play.mygame.com/connect', room: 'mygame', auth: { name: 'WREN' } });
const lobby = new LobbyClient(net);
net.bindPageLifecycle();                 // pause in the background, come back fast
net.connect();
await net.whenOnline();

await lobby.quickPlay({ mode: 'coop' }); // or lobby.create() / lobby.join('KQXT')
lobby.onRoom = room => drawLobby(room);  // members, seats, ready, lobby.countdownMs()
await lobby.setReady(true);

net.onState = s => snapshots.push(s);    // s.via is 'rtc' or 'ws'
net.onEvent = e => applyEvent(e);
net.sendEvent({ type: 'shoot', aim: 0.4 });   // ordered, acknowledged
net.sendState(1, encodeInput(input));         // latest wins
```

## Examples

- **[`examples/party`](examples/party)**: a complete little game. Quick play or a room by code, ready-up, then move
  around a shared arena and chat. Server-authoritative movement with client-side prediction and reconciliation, other
  players interpolated, inputs sent redundantly. About 300 lines. `npm run build && npm run example`, then open
  http://127.0.0.1:8790 in two tabs (`RTC=1` for WebRTC).
- **[`examples/arena`](examples/arena)**: the transport on its own, with live numbers (path, RTT, bytes).
  `npm run demo`.

Used in production by **[Nocturne Keep](https://nocturnekeep.com)**: co-op story, maker rooms and a roguelike played
together, with the game's own code running each room's world on a $5 server.

## Documentation

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
