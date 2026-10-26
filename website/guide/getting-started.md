# Your first working game

<p class="lede">A real authoritative server, two browser tabs, and a reconnect you can see. Start with a complete project, then change it.</p>

[Try the live arena first](https://twinwire-demo.hak7alp.workers.dev/). Share the invite URL between two tabs, move a player, then disconnect and reload. The hosted example uses WebSocket. The complete Node project below adds an optional native datagram path.

## Run it

Use **Node 22 or newer**. Download the <a href="/twinwire/twinwire-starter.tgz" download>standalone starter</a> and extract it into an empty
folder. In that folder:

~~~sh
npm install
npm start
~~~

Open **http://127.0.0.1:8787** in two tabs. You should see an amber player for yourself and a violet player for the
other tab. WASD, arrow keys and a drag inside the arena all move your player.

Alternatively, clone the source:

~~~sh
git clone https://github.com/studiokimeiga/twinwire.git
cd twinwire/examples/starter
npm install
npm start
~~~

### Prove recovery

1. Click **Send reliable ping**. Your score increases once when the server acknowledges it.
2. Click **Disconnect for 2 seconds**. The arena waits for a fresh snapshot.
3. Watch the same session ID and score return; the resume count increases.
4. Reload this tab. Its sessionStorage checkpoint resumes the same player within the 30-second grace period.
5. Add **?rtc=0** to a new tab for a WebSocket-only control.

A checkpoint contains a private resume token: keep it in a per-player store, never put it in a shared URL.
An expired session needs an explicit new start; old actions are not sent to a new player.

## The server

This is the complete starter server, including its simulation and static-file routes:

<<< ../../examples/starter/server.mjs{js}

The game validates direction, normalizes diagonal movement, caps speed, and stops stale input. Twinwire retains the
session through a socket interruption; the game removes its player only when the session expires.
Replaceable direction is stream 1. The complete authoritative world is stream 0. A ping is a reliable event.

## The page

The starter serves the browser module from the **same installed package** as the server. It has no CDN version
to drift and no bundler to configure.

<<< ../../examples/starter/public/game.mjs{js}

The recovery boundary is the important part: **receiveState** decodes and applies a usable snapshot before
releasing playback. A socket reconnect alone does not mean the world is ready. Its reset callback clears old
world history on both a new session and a resume. [The recovery guide](/guide/recovery) explains the choices.

## Add datagrams

The starter includes optional **node-datachannel 0.33.x**. Start with WebSocket, then:

::: code-group
~~~sh [macOS / Linux]
RTC=1 npm start
~~~
~~~powershell [PowerShell]
$env:RTC='1'
npm start
~~~
:::

The server uses UDP 8788 by default. A requested RTC start fails if the native module cannot load.
The browser initially connects over WebSocket and upgrades only when probe replies prove the datagram path.
The same session falls back when that proof expires. Opening a data channel alone is insufficient.

## Add rooms and prediction

The starter deliberately has one arena and simple authoritative playback. The [party example](/guide/party) adds
the **Lobby**, quick play, codes, ready-up, client prediction, interpolation and chat.

## Before you ship

- Host the page over HTTPS and its connection over WSS. Configure exact page origins in **ORIGINS**.
- Set **HOST=0.0.0.0** for a remotely accessible server. Open its TCP port and, for RTC, the configured UDP port.
- Validate actions and input on the server. Origins are not authentication; use **authenticate** for accounts.
- Keep persistence, authority and collision in your game. A network ACK is not a saved database transaction.
- Deploy browser and server together when changing Twinwire versions or your game protocol.

[Operations](/reference/operations) covers reverse proxies, limits, TURN and rollout.
[Compatibility and verification](/reference/verification) describes what the release checks establish.
