# Validation status: 2.0.0 (2026-10-25)

## Unreleased: recovered RTC paths clear retry debt

An isolated real-Chromium/native-RTC test used Linux network namespaces and port-specific INPUT/OUTPUT UDP drops,
with WSS still available through a local TLS proxy. Published 2.0.0 fell back in 1.44–1.48 s with identity, seat and
ordered actions preserved. Its retry counter remained elevated after proven recovery; a second observation recovered
in 2.48 s then 11.50 s, while an earlier run exceeded the declared 15 s recovery budget. That original failure is
retained, not replaced by the subsequent pass. These are functional observations on one host, not cellular or capacity results.

The candidate clears debt only when datagrams are proven and ignores duplicate resets after an attempt has stopped.
Its OS-level repeat fell back in 1.449/1.479 s and restored RTC in 2.468/2.852 s after UDP restoration. All 190 actions
were applied and echoed once, in order, with the same identity/seat/epoch through both wire transitions.

RTC-backoff checks: `npm run check` **126/126 pass**; native gate **three repeat recoveries pass**, including duplicate resets;
all three browser engines pass normal/impaired/WS-only runs and the party example on WS and RTC. The native regression
also fails against the published runtime: first retry offer 2033 ms for a 250 ms base/750 ms budget. With the fix,
the three offers took 260/265/252 ms. Each path is kept healthy beyond the server's one-second offer-rate limit before
the next induced outage. Tests use local native/browser connections, not physical phones or a measured radio network.

This candidate is unreleased and has not changed the deployed games. No wire/version change is required.

A further takeover regression reproduced the additional published-runtime `Unexpected binary frame` report: input
queued on the old socket arrived after its session record had been retired. The old player was already protected,
but the closing socket could still reach the handshake path. The guard now ignores all traffic on that retired
authenticated connection. A real-WebSocket test also queues a repeated hello and verifies it cannot reclaim the
player. It failed before the guard and passes afterward; the final core suite passes **127/127**. The final isolated
Chromium/TLS suite passes all nine payload-size boundaries plus within-grace resume, expiry/new-session and checkpoint
takeover, with 76 ordered once-only actions and no page/client/server errors. Clients leave zero sessions and members;
empty lobby objects retain their configured 30-second expiry until the staging server is stopped.

Run on Linux (WSL2, x86-64), Node 22.21.1, node-datachannel 0.33.4, Playwright 1.63.0.

| Check | Result |
|---|---|
| `npm run check` | PASS: strict TypeScript build, 126 tests, 0 skipped (including protocol 4's header sizes, quarter-millisecond times, malformed and truncated headers, wrong version, the four-day reconnect resuming on a new epoch and time base, and a time a frame can't carry refused at `sendState`) (unit, localhost WebSocket integration, lobby, package exports, and an independent review's lobby-lifecycle and delivery-contract suites). |
| `npm run test:native` | PASS: node-datachannel's WebRTC client and the native server select real datagrams, fall back to the WebSocket when one end drops the channel, recover, and keep the same session. |
| `npm run test:browser` | PASS in Chromium 153, Firefox 155 and WebKit 26.6 (Safari's engine), desktop and phone contexts: real browser WebRTC to the native server, 60/60 states over RTC, lobby by code, ready-up, events both ways, a 50 KB snapshot, pause/resume into the same session and seat. `browsers.json`. |
| `IMPAIR=1 npm run test:browser` | PASS in all three: 40 ms each way, 20 ms jitter, 5% datagram loss on both ends; 50 to 51 of 60 latest-wins states arrive (as designed under ~10% two-hop loss), every event arrives. `browsers-impaired.json`. |
| `RTC=0 npm run test:browser` | PASS in all three over the WebSocket only. `browsers-ws.json`. |
| `npm run test:example` (and `RTC=1`) | PASS in all three engines over both transports: two players meet by code, ready up, one moves ~130 px, the other draws it within 0.00 px of where its owner predicts itself, chat arrives. |
| `npm run bench -- --clients 50 --seconds 5` | 50 WebSocket clients at 20 Hz, 8 recipients each: 39,600 deliveries, no errors, event-loop p99 11.24 ms (2.0.0 rerun, 2026-10-25 18:54 Eastern) (server and clients in one process). |
| `npm run soak -- --minutes 10 --clients 48 --hostile 6` | PASS: a Lobby server with 48 clients living short lives (states at 20 Hz, echoed events, a clean close, a killed socket, pauses shorter and longer than the resume grace, room changes, garbage on a live socket) and 6 hostile clients (random bytes and text, 2 MB frames, floods, forged resumes, deep JSON, idle sockets, connection bursts). 1,507 client lives, 93,452 events sent and none lost, duplicated or reordered in a session that lived (the 109 not echoed belong to sessions deliberately paused past the grace); 1.01 million states relayed; heap 10.1 MB mid-run, 9.2 MB late; event-loop p99 at most 11.1 ms; every session, connection, room and timer gone afterwards. (1.1.0 also passed a 15-minute run.) |
| `npm audit` | 0 vulnerabilities (the only runtime dependency is `ws`). |
| Production (1.x) | Nocturne Keep (nocturnekeep.com) runs on 1.x, not yet 2.0 (protocol 4 needs its server and client upgraded together): its seven multi-browser suites and a live check of the public site in Chromium and WebKit pass, over WebRTC to a 1-vCPU server. |
| A 50-player shared world (kimu.nyc, Twinwire 1.1) | Its bots harness: 50 clients and the room server on one machine, the network emulated both ways (one-way delay plus jitter, per-packet loss, and on the WebSocket a TCP stall per loss), interleaved runs, 2 reps x 6 windows. Delay / error p99 / error max of one player's replay of the other 49, against kimu's own hand-built stack (old). **5G WebRTC** old 106-116 ms / 0.6-0.9 cm / 3-16 cm, Twinwire 1.1 113-119 ms / 0.2 cm / 2-21 cm. **5G WebSocket** old 109-126 / 0.4-0.5 / 3-18, 1.1 116-135 / 0.2 / 3-11. **Congested cell WebRTC** old 178-189 / 0.5-11 / 4-60, 1.1 177-189 / 0.2-3.8 / 5-52. **Congested cell WebSocket** old 290-338 / 0.8-3.6 / 13-39, 1.1 311-343 / 0.5-4.5 / 9-59. (1.1 = `lateStates: 'deliver'` and `AdaptivePlayback`, no workarounds.) Clock offset spread across the 50 clients: 7-11 ms (1.0: 20-27 ms; kimu's old sync: 11-18 ms). The 5G delay difference traces to 50 clients sharing one Node event loop in the harness (p99 22 ms vs 18 ms), not the wire. |
| Physical iPhone on cellular | Not run here. WebKit in Playwright is Safari's engine on Linux, not iOS Safari on a phone radio. |

The impairment numbers come from Twinwire's own simulator (application-level delay and drop), not OS-level traffic
shaping or a measured cellular network.

## What the browser test does

`tools/browser-e2e.mjs` starts a `GameServer` with the native WebRTC factory on a random UDP port and a `Lobby`, serves
`dist/browser/twinwire.js`, and for each engine opens a desktop context and a phone context (`isMobile` and touch where
the engine supports it). The two players meet by room code, ready up, and the server relays each player's states and
events to the other through the lobby callbacks. It fails if Chromium can't reach the RTC path, on any page error, or
if a resumed player comes back in a different session or seat.

## Twinwire 2.0 CS2 measurement

The 10-bot comparison finished 36/36 runs (3 scenarios × 2 transports × 2 stacks × 3 repetitions).
Three more interleaved repetitions per stack confirmed congested WebRTC behavior. The package measured was
`twinwire-2.0.0.tgz`, SHA-256 `07126a913f05113cbf245f42febd940bfd9e2047d8df980e2a065f538df3f672`,
from source `87929e7`. All 95 installed files matched it before confirmation. The harness was CS2 `09a9fee`.
The original logs and raw records remain under CS2 `artifacts/netbench/2026-10-25T20-44-56`; confirmation is
`artifacts/netbench/2.0.0-congested-rtc-confirm-20261025`.

Delivery and latency track the emulated network on both stacks. In the six congested-RTC repetitions per stack,
snapshot misses were 2.020% geckos vs 1.993% Twinwire; input p99 averaged 74.41 vs 75.15 ms. Original Twinwire
WebRTC downstream was 4.4–11.1 KiB/s lower, while upstream remained 0.8–1.1 KiB/s higher; the 12-byte header
removes 640 bytes/s from a 64-Hz stream compared with the old 22-byte header. WebSocket downstream remained
0.5–1.1 KiB/s higher than the game's unframed legacy transport.

One original Twinwire congested-RTC run had 8.77 ms tick p99; the three confirmation runs were 1.17–1.42 ms,
versus 1.03–1.12 ms geckos, with mean server CPU 18.59% vs 18.95%. The outlier remains in the aggregate;
combat load varies, and one low-movement bot was flagged in each of two original runs. This evidence supports
the tested delivery/latency behavior, but does not establish universal CPU parity or physical cellular results.
The A/B run predates the separate game lag-compensation fix.

Release and application deployment remain separate gates; a local pack or a PR is not npm publication.

## Published package identity

`twinwire@2.0.0` and the `latest` dist-tag were verified on public npm after the
GitHub-hosted `v2.0.0` release workflow used OIDC trusted publishing successfully.
Published source/tag: `6248572d0af6b3f49c08865b2f71bd10fb66804c` / `v2.0.0`.
Published tarball SHA-256: `a8244eddb3f279317cc27c116d2db8d2c4f540a2ea7677cc130de881c3a5cacd`.
The downloaded 95-file tarball exactly matches the final local pack, including its SHA-512 registry integrity.
Compared with the measured `07126a91…` candidate, only ADOPTING, ARCHITECTURE and OPERATIONS documentation differs;
all runtime files and package.json are byte-identical. npm exposes a SLSA provenance attestation.
The registry initially returned 404 during npm processing; verification waited for a real public download.
