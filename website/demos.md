# Touch the network

<p class="lede">Seven small lessons, each running Twinwire itself. Change one thing and see why a networking decision matters.</p>

The teaching demos run both endpoints inside this browser. They use the library's session, framing, interpolation
and lobby code over a simulated network. They do **not** open a real remote WebRTC connection, measure your internet
connection, or certify a device. [Run the starter](/guide/getting-started) for a real browser-to-server game.

| Try this | What to watch | Code |
| --- | --- | --- |
| [Drop and resume a session](/how/sessions) | Same ID and seat; pending events arrive once. An expired session needs an explicit new start. | [Session demo](https://github.com/studiokimeiga/twinwire/blob/main/website/.vitepress/theme/components/demos/SessionsDemo.vue) |
| [Block the datagram path](/how/two-wires) | Two-way probe proof expires; states fall back to the WebSocket. | [Wires demo](https://github.com/studiokimeiga/twinwire/blob/main/website/.vitepress/theme/components/demos/WiresDemo.vue) |
| [Add jitter and packet loss](/how/interpolation) | Raw snapshots jump; buffered playback trades a little latency for smooth motion. | [Interpolation demo](https://github.com/studiokimeiga/twinwire/blob/main/website/.vitepress/theme/components/demos/InterpolationDemo.vue) |
| [Predict your movement](/how/prediction) | Local input moves now; authoritative corrections settle disagreement. | [Prediction demo](https://github.com/studiokimeiga/twinwire/blob/main/website/.vitepress/theme/components/demos/PredictionDemo.vue) |
| [Lose a delta base](/how/deltas) | A delta is usable only when its acknowledged base exists; a full snapshot restores it. | [Delta demo](https://github.com/studiokimeiga/twinwire/blob/main/website/.vitepress/theme/components/demos/DeltaDemo.vue) |
| [Move through an interest area](/how/interest) | Only nearby entities are selected; the game defines visibility and authority. | [Interest demo](https://github.com/studiokimeiga/twinwire/blob/main/website/.vitepress/theme/components/demos/InterestDemo.vue) |
| [Create a room and ready up](/how/lobby) | Stable seats, a server-clock countdown and host handoff. | [Lobby demo](https://github.com/studiokimeiga/twinwire/blob/main/website/.vitepress/theme/components/demos/LobbyDemo.vue) |

## Play the real starter

[Open a live arena](https://twinwire-demo.hak7alp.workers.dev/), then copy its invite URL into another tab. Movement and the ping score come from a real authoritative server. Disconnect and reload to check the same ID and score. It uses WebSocket in a Durable Object; it does not simulate WebRTC or claim durable transport storage.

[Run the Node version with optional native WebRTC](/guide/getting-started) · [Read the Worker source](https://github.com/studiokimeiga/twinwire/tree/main/examples/starter-worker)

## A real multiplayer game

The <a href="/twinwire/twinwire-starter.tgz" download>standalone starter</a> has actual sockets, authoritative movement, a touch/keyboard arena,
reliable actions and a reconnect button. No art assets, account or build tool are required.

The [party example](/guide/party) adds quick play, room codes, ready-up, prediction, interpolation and chat.
Both include their source. Keep the server and browser on the same Twinwire release.

## Live game integrations

These games run Twinwire 2.2.0. Their deployed clients were checked with independent browsers,
actual gameplay and a dropped connection. The games own their simulation, accounts, assets and persistence.

| Game | Try it | Recovery exercised |
| --- | --- | --- |
| Nocturne Keep | [Co-op platforming](https://nocturnekeep.com) | Same players and private room, current combat world |
| kimu.nyc | [Shared city](https://kimu.nyc) | Same players, nearby world snapshots and playback after reconnect |
| CS2 browser prototype | [Authoritative shooter](http://140.82.43.143:8080/mp.html) | Movement, fire events, same session and fresh world |
| Superfighters | [Two-player arena](https://hakanalpay.com/superfighters/) | Same round, released held controls and current host world |
| Emoji Mahjong | [Private tile hands](https://emojimahjong.pages.dev/) | Original seats and hands after disconnect and reload |
| Gallax | [Shared map world](https://gallax.pages.dev/) | Movement, same position and one delivery of queued chat |
| Webstrike | [Multiplayer shooter](http://140.82.43.143/?online) | Movement, fire, retained player and cleanup on leaving |
| Sipoga / NT Web | [Multiplayer FPS](https://hakanalpay.com/sipoga/) | Movement, damage, respawn and retained player after an 8.5-second drop |
| Wollosseum prototype | [Command arena](https://wollo.66-135-17-35.sslip.io/) | Commands and the same seat and world after reconnect |
| TDBR prototype | [Top-down arena](https://tdbr.66-135-17-35.sslip.io/) | Movement, firing and the same player, inventory and world |

The Node games were checked on both native WebRTC and forced WebSocket. Emoji Mahjong uses
the Worker WebSocket host; its private-hand recovery was also checked in phone-sized WebKit.
The two arena prototypes use small public capacity profiles. These checks cover the listed
scenarios; [the verification record explains their limits](/reference/verification).
