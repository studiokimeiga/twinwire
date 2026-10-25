# Validation status: 1.0.0 (2026-10-25)

Run on Linux (WSL2, x86-64), Node 22.21.1, node-datachannel 0.33.4, Playwright 1.63.0.

| Check | Result |
|---|---|
| `npm run check` | PASS: strict TypeScript build, 89 tests, 0 skipped (unit, localhost WebSocket integration, lobby, package exports). |
| `npm run test:native` | PASS: node-datachannel's WebRTC client and the native server select real datagrams, fall back to the WebSocket when one end drops the channel, recover, and keep the same session. |
| `npm run test:browser` | PASS in Chromium 153, Firefox 155 and WebKit 26.6 (Safari's engine), desktop and phone contexts: real browser WebRTC to the native server, 60/60 states over RTC, lobby by code, ready-up, events both ways, a 50 KB snapshot, pause/resume into the same session and seat. `browsers.json`. |
| `IMPAIR=1 npm run test:browser` | PASS in all three: 40 ms each way, 20 ms jitter, 5% datagram loss on both ends; 48 to 54 of 60 latest-wins states arrive (as designed under ~10% two-hop loss), every event arrives. `browsers-impaired.json`. |
| `RTC=0 npm run test:browser` | PASS in all three over the WebSocket only. `browsers-ws.json`. |
| `npm run test:example` (and `RTC=1`) | PASS in all three engines over both transports: two players meet by code, ready up, one moves ~130 px, the other draws it within 0.00 px of where its owner predicts itself, chat arrives. |
| `npm run bench -- --clients 50 --seconds 5` | 50 WebSocket clients at 20 Hz, 8 recipients each: 39,600 deliveries, no errors, event-loop p99 12 ms (server and clients in one process). |
| `npm audit` | 0 vulnerabilities (the only runtime dependency is `ws`). |
| Production | Nocturne Keep (nocturnekeep.com) runs on it: its seven multi-browser suites and a live check of the public site in Chromium and WebKit pass, over WebRTC to a 1-vCPU server. |
| Physical iPhone on cellular | Not run here. WebKit in Playwright is Safari's engine on Linux, not iOS Safari on a phone radio. |

The impairment numbers come from Twinwire's own simulator (application-level delay and drop), not OS-level traffic
shaping or a measured cellular network.

## What the browser test does

`tools/browser-e2e.mjs` starts a `GameServer` with the native WebRTC factory on a random UDP port and a `Lobby`, serves
`dist/browser/twinwire.js`, and for each engine opens a desktop context and a phone context (`isMobile` and touch where
the engine supports it). The two players meet by room code, ready up, and the server relays each player's states and
events to the other through the lobby callbacks. It fails if Chromium can't reach the RTC path, on any page error, or
if a resumed player comes back in a different session or seat.
