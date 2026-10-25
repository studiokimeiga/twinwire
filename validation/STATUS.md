# Validation status: 1.1.2 (2026-10-25)

Run on Linux (WSL2, x86-64), Node 22.21.1, node-datachannel 0.33.4, Playwright 1.63.0.

| Check | Result |
|---|---|
| `npm run check` | PASS: strict TypeScript build, 119 tests, 0 skipped (unit, localhost WebSocket integration, lobby, package exports, and an independent review's lobby-lifecycle and delivery-contract suites). |
| `npm run test:native` | PASS: node-datachannel's WebRTC client and the native server select real datagrams, fall back to the WebSocket when one end drops the channel, recover, and keep the same session. |
| `npm run test:browser` | PASS in Chromium 153, Firefox 155 and WebKit 26.6 (Safari's engine), desktop and phone contexts: real browser WebRTC to the native server, 60/60 states over RTC, lobby by code, ready-up, events both ways, a 50 KB snapshot, pause/resume into the same session and seat. `browsers.json`. |
| `IMPAIR=1 npm run test:browser` | PASS in all three: 40 ms each way, 20 ms jitter, 5% datagram loss on both ends; 48 to 54 of 60 latest-wins states arrive (as designed under ~10% two-hop loss), every event arrives. `browsers-impaired.json`. |
| `RTC=0 npm run test:browser` | PASS in all three over the WebSocket only. `browsers-ws.json`. |
| `npm run test:example` (and `RTC=1`) | PASS in all three engines over both transports: two players meet by code, ready up, one moves ~130 px, the other draws it within 0.00 px of where its owner predicts itself, chat arrives. |
| `npm run bench -- --clients 50 --seconds 5` | 50 WebSocket clients at 20 Hz, 8 recipients each: 39,600 deliveries, no errors, event-loop p99 12 ms (server and clients in one process). |
| `npm run soak -- --minutes 10 --clients 48 --hostile 6` | PASS: a Lobby server with 48 clients living short lives (states at 20 Hz, echoed events, a clean close, a killed socket, pauses shorter and longer than the resume grace, room changes, garbage on a live socket) and 6 hostile clients (random bytes and text, 2 MB frames, floods, forged resumes, deep JSON, idle sockets, connection bursts). 94,128 events with none lost, duplicated or reordered; heap flat at 9.0 to 9.3 MB; event-loop p99 11 ms; every session, connection, room and timer gone afterwards. A 15-minute run passed the same checks. |
| `npm audit` | 0 vulnerabilities (the only runtime dependency is `ws`). |
| Production | Nocturne Keep (nocturnekeep.com) runs on it: its seven multi-browser suites and a live check of the public site in Chromium and WebKit pass, over WebRTC to a 1-vCPU server. |
| A 50-player shared world (kimu.nyc) | Its bots harness: 50 clients and the room server on one machine, the network emulated both ways (one-way delay plus jitter, per-packet loss, and on the WebSocket a TCP stall per loss), interleaved runs, 2 reps x 6 windows. Delay / error p99 / error max of one player's replay of the other 49, against kimu's own hand-built stack (old). **5G WebRTC** old 106-116 ms / 0.6-0.9 cm / 3-16 cm, Twinwire 1.1 113-119 ms / 0.2 cm / 2-21 cm. **5G WebSocket** old 109-126 / 0.4-0.5 / 3-18, 1.1 116-135 / 0.2 / 3-11. **Congested cell WebRTC** old 178-189 / 0.5-11 / 4-60, 1.1 177-189 / 0.2-3.8 / 5-52. **Congested cell WebSocket** old 290-338 / 0.8-3.6 / 13-39, 1.1 311-343 / 0.5-4.5 / 9-59. (1.1 = `lateStates: 'deliver'` and `AdaptivePlayback`, no workarounds.) Clock offset spread across the 50 clients: 7-11 ms (1.0: 20-27 ms; kimu's old sync: 11-18 ms). The 5G delay difference traces to 50 clients sharing one Node event loop in the harness (p99 22 ms vs 18 ms), not the wire. |
| Physical iPhone on cellular | Not run here. WebKit in Playwright is Safari's engine on Linux, not iOS Safari on a phone radio. |

The impairment numbers come from Twinwire's own simulator (application-level delay and drop), not OS-level traffic
shaping or a measured cellular network.

## What the browser test does

`tools/browser-e2e.mjs` starts a `GameServer` with the native WebRTC factory on a random UDP port and a `Lobby`, serves
`dist/browser/twinwire.js`, and for each engine opens a desktop context and a phone context (`isMobile` and touch where
the engine supports it). The two players meet by room code, ready up, and the server relays each player's states and
events to the other through the lobby callbacks. It fails if Chromium can't reach the RTC path, on any page error, or
if a resumed player comes back in a different session or seat.
