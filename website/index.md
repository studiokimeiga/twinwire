---
layout: page
title: Twinwire
titleTemplate: Multiplayer networking for browser games
---

<HomeHero />

<div class="vp-doc home">

<div class="start-paths">
<a href="./guide/getting-started"><span>BUILD</span><strong>Your first working game</strong><p>A complete server and browser client. Download, run, open two tabs.</p></a>
<a href="./demos"><span>EXPLORE</span><strong>Make the network misbehave</strong><p>Drop a connection, block datagrams, or add jitter. Watch what changes.</p></a>
<a href="./guide/recovery"><span>SHIP</span><strong>Recover the world, too</strong><p>Keep the same player and wait for fresh state before playback resumes.</p></a>
</div>

## Try a reconnect

The same player can outlive a socket. Click **Drop the connection** and watch it resume automatically. The session ID and lobby seat
stay the same within the grace period; unacknowledged events replay once. This runs Twinwire's session code in a
local simulation. [What the demo does](/how/sessions) · [All seven interactive lessons](/demos)

<SessionsDemo />

## What it does

Your game keeps its rules, physics and rendering. Twinwire carries the bytes and the session; your server decides
what is true.

<FeatureGrid />

## Start with a running game

[Play the live arena](https://twinwire-demo.hak7alp.workers.dev/) in two tabs using the same invite URL. Move, send a reliable ping, and disconnect for two seconds. This is a real hosted WebSocket game, with a separate private arena per invite. The downloadable Node version also supports native WebRTC.

Download the <a href="/twinwire/twinwire-starter.tgz" download>standalone starter</a>, extract it, then run:

~~~sh
npm install
npm start
~~~

Open **http://127.0.0.1:8787** in two tabs. Move your player, send a reliable ping, disconnect for two seconds,
and reload the page. Your ID and score survive the interruption. The starter uses the published package and
serves its own browser module; no bundler or account is needed.

[Read the complete walkthrough](/guide/getting-started) ·
[Browse the starter source](https://github.com/studiokimeiga/twinwire/tree/main/examples/starter)

Already have a game? [Port an existing transport](/reference/adopting), keep your current simulation, and
deploy the client and server together. For rooms, ready-up, prediction and chat, start from the
[party example](/guide/party).

## Used in real games

- [Nocturne Keep](https://nocturnekeep.com): a pixel-art co-op platformer. Persistent worlds and combat remain game-owned.
- [kimu.nyc](https://kimu.nyc): a shared city, with interest groups and adaptive playback for nearby players.
- CS2 browser prototype: authoritative shooter movement, fire events and paired client/server releases.

The 2.2 release also runs in seven more games, including a turn-based Worker game and several arena games.
[Explore all ten live integrations](/demos#live-game-integrations).
[Read the release evidence and its limits](/reference/verification).

## What you bring

Twinwire is a library, under the MIT license. You host a Node server or a compatible Worker, plus your client, choose your physics and
serialization, and validate player actions. It does not supply a database, an account system, or a global room
allocator. A WebSocket is enough to start; native WebRTC is optional.

[Deployment and TURN](/reference/operations) · [API reference](/reference/api/) ·
[Report a reproducible issue](https://github.com/studiokimeiga/twinwire/issues)

</div>

<style>
.home { max-width: 1152px; margin: 0 auto; padding: 8px 24px 64px; }
.home > h2:first-child { margin-top: 24px; }
.home ul { max-width: 52em; }
.start-paths { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 18px; margin: 28px 0 44px; }
.start-paths a { padding: 22px; border: 1px solid var(--tw-rule); border-radius: 10px; background: var(--tw-panel); text-decoration: none; color: var(--tw-ink); }
.start-paths a:hover { border-color: var(--tw-ws); }
.start-paths a:focus-visible { outline: 3px solid var(--tw-ws); outline-offset: 3px; }
.start-paths span { display:block; font: 12px var(--tw-font-mono); color: var(--tw-dg); margin-bottom: 8px; letter-spacing: .1em; }
.start-paths strong { display:block; font: 700 26px var(--tw-font-display); line-height: 1.2; }
.start-paths p { font-size: 15px; line-height: 1.5; margin: 10px 0 0; color: var(--tw-ink-2); }
@media (max-width: 760px) { .start-paths { grid-template-columns: 1fr; gap: 12px; } }
@media (max-width: 640px) { .home { padding: 0 24px 48px; } }
</style>
