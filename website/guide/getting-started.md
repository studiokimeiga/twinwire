# Getting started

<p class="lede">A room server in Node, a page that connects to it, and a lobby to meet in. About forty lines between them.</p>

## Install

```sh
npm install twinwire
npm install node-datachannel   # on the server only, for WebRTC datagrams
```

Twinwire needs Node 22 or newer on the server. `node-datachannel` (0.33.x) is optional: without it, everything runs over
the WebSocket, which works everywhere HTTPS does. Add it once you want UDP-like delivery for game state.

## The server

The server owns the truth. It accepts connections, keeps each player's session, and hands you rooms through the lobby.

```js
import { createGameServer, createNativeRtcFactory, Lobby } from 'twinwire/server';

const server = await createGameServer({
  port: 8787,
  origins: ['https://mygame.com'],                      // exact page origins; never a wildcard
  rtc: await createNativeRtcFactory({ port: 8788 }),    // one UDP port for every player
});
const lobby = new Lobby(server, { maxMembers: 4, ready: { countdownMs: 3000 } });

lobby.onCreate = room => { room.data = createWorld(); };
lobby.onEvent = (room, member, msg) => room?.data.command(member.seat, msg);       // validate, then apply
lobby.onState = (room, member, state) => room?.data.input(member.seat, state.data);

setInterval(() => {
  for (const room of lobby.rooms.values()) {
    if (room.phase !== 'playing') continue;
    room.data.step();
    for (const m of room.members.values())
      if (m.connected) m.session.sendState(0, room.data.snapshotFor(m.seat));
  }
}, 1000 / 30);

await server.listen();
```

`createWorld`, `command`, `input`, `step` and `snapshotFor` are your game. Twinwire doesn't simulate anything: it
carries bytes and keeps sessions, and your code decides what is legal.

Once a lobby is attached, it owns each session's `onEvent` and `onState`. Use the lobby's callbacks instead; they
tell you which room and which member a message came from (`null` for a session that isn't in a room).

## The page

```js
import { GameClient, LobbyClient } from 'twinwire/client';

const net = new GameClient({
  url: 'wss://play.mygame.com/connect',
  room: 'mygame',                        // a namespace the server sees, not a game room
  auth: { name: 'WREN', build: BUILD },  // any JSON; the server's authenticate hook can check it
});
const lobby = new LobbyClient(net);
net.bindPageLifecycle();                 // pause in the background, come back fast
net.connect();
await net.whenOnline();

await lobby.quickPlay({ mode: 'coop', match: { build: BUILD } });
lobby.onRoom = room => drawLobby(room);  // members, seats, ready, lobby.countdownMs()
await lobby.setReady(true);

net.onEvent = e => applyEvent(e);        // each event once, in order
net.onState = s => snapshots.push(s);    // the newest per stream; s.via is 'rtc' or 'ws'
net.sendEvent({ type: 'shoot', aim: 0.4 });
net.sendState(1, encodeInput(input));
```

`whenOnline()` resolves once the session is up, and rejects if the session is lost or closed first. `onSession`
tells you when it is new (`resumed: false`: reset your game state) and when it came back after a drop (`resumed: true`:
carry on).

## Two kinds of message

Almost every bug in multiplayer netcode comes from sending something the wrong way. Twinwire gives you exactly two:

| | Events: `sendEvent(json)` | States: `sendState(stream, bytes)` |
|---|---|---|
| For | Things that must arrive, in order: hits, doors, purchases, chat, map changes | Things where only the newest matters: positions, snapshots, inputs |
| Delivery | Every one, once, in order, replayed after reconnects | Latest wins per stream; older ones are dropped, not queued |
| Path | The WebSocket, raced by a copy on the datagrams | Datagrams while they work, else the WebSocket |
| Format | JSON, up to 64 KiB | Bytes, up to 64 KiB (one datagram up to 1086 bytes) |

Events and states travel separately, so nothing orders one against the other. When a snapshot depends on an event (a
map change, a respawn), stamp both with the server tick or a generation number. [Adopting it](/reference/adopting)
has the full pattern.

## Without a bundler

`twinwire/browser` is the client, the lobby client and the netcode in one file that defines `window.Twinwire`
(15 KB gzipped, for Safari 15 and every evergreen browser):

```html
<script src="https://cdn.jsdelivr.net/npm/twinwire@1.0.0/dist/browser/twinwire.min.js"></script>
<script>
  const net = new Twinwire.GameClient({ url: 'wss://play.mygame.com/connect', room: 'mygame' });
  const lobby = new Twinwire.LobbyClient(net);
</script>
```

Or as a module: `import { GameClient } from 'https://cdn.jsdelivr.net/npm/twinwire@1.0.0/dist/browser/twinwire.mjs'`.
Serve your own copy from `node_modules/twinwire/dist/browser/` if you'd rather not depend on a CDN.

## Try a whole game

The repository has a complete small game: quick play or a room by code, ready-up, then a shared arena with prediction,
interpolation and chat.

```sh
git clone https://github.com/studiokimeiga/twinwire && cd twinwire
npm install && npm run build
npm run example           # then open http://127.0.0.1:8790 in two tabs
RTC=1 npm run example     # the same over WebRTC datagrams
```

[The party example](/guide/party) walks through its code.

## Before you ship

- Serve the page over HTTPS and the WebSocket over WSS, behind a proxy such as Caddy; open the UDP port in the firewall.
- List your exact page origins. Behind a local proxy, set `trustProxy: true` so per-address limits see real addresses.
- Validate every event and input on the server. Origin is not authentication; use `authenticate` if you have accounts.
- Add TURN once you've measured players stuck on the WebSocket who would benefit.

[Operations](/reference/operations) covers each of these.
