---
layout: page
title: Twinwire
titleTemplate: Multiplayer networking for browser games
---

<HomeHero />

<div class="vp-doc home">

## What it does

Your game keeps its rules, physics and rendering. Twinwire carries the bytes and the session; your server decides what
is true.

<FeatureGrid />

## Quick start

```sh
npm install twinwire
npm install node-datachannel   # on the server, for WebRTC (optional: without it, WebSocket only)
```

::: code-group

```js [server.mjs (Node 22+)]
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

```js [game.js (browser)]
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

:::

No bundler? `twinwire/browser` is one script that defines `window.Twinwire`. The [getting started guide](/guide/getting-started)
goes through it step by step.

## How it works

Each page explains one idea and lets you poke at it. The simulations run the library itself in your browser.

- [Sessions that survive](/how/sessions): one player, many connections, and what happens to the seat in between.
- [Two wires](/how/two-wires): why a WebSocket alone stutters, and how datagrams are proven, used and given up.
- [Snapshot interpolation](/how/interpolation): drawing other players smoothly from snapshots that arrive late, early or not at all.
- [Prediction and reconciliation](/how/prediction): moving your own player now, and agreeing with the server later.
- [Delta snapshots](/how/deltas): sending only what changed since the last snapshot a player acknowledged.
- [Interest management](/how/interest): sending each player only what is near them.
- [The lobby](/how/lobby): room codes, quick play, seats, and ready-up with a countdown.

## In production

[Nocturne Keep](https://nocturnekeep.com), a pixel-art platformer, plays its co-op story, maker rooms and roguelike
over Twinwire, with each room's world run by the game's own code on a $5 server. Its live check plays the public site in
Chromium and WebKit over WebRTC. [How it moved onto Twinwire](/reference/adopting#a-real-port-nocturne-keep).

</div>

<style>
.home { max-width: 1152px; margin: 0 auto; padding: 8px 24px 64px; }
.home > h2:first-child { margin-top: 24px; }
.home ul { max-width: 46em; }
@media (max-width: 640px) { .home { padding: 0 24px 48px; } }
</style>
