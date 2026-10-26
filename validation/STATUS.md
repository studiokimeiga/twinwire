# Validation status: 2.2.0 (2026-10-26)

The release runtime passes154 local checks, native RTC, Chromium/Firefox/WebKit normal, impaired and WebSocket-only runs, and the party example on both paths. The final [Node22/24 sixty-minute run](https://github.com/studiokimeiga/twinwire/actions/runs/40365174817) at8e79d0f completed successfully. Both independent hours report no lost/duplicated/reordered echo in sessions that lived, every honest life online, bounded heap, event-loop p99 under50ms, no unexpected server errors and zero sessions/connections/rooms/timers/sockets after drain. Hostile garbage/forged/flood traffic produces expected protocol rejections.

The subsequent Worker-only fix changes worker.js/map/declaration; all101 Node/browser distributed files are byte-identical to that hour-tested runtime. The real workerd compatibility matrix passes both2025-01-01 and2026-03-17 binary delivery, ordered replay, same-ID recovery, takeover, origin checks and prompt close handshakes. Hosted core gates execute this matrix on Node22/24. Runnable Node/Worker starter source and documentation change no library runtime bytes. Actual Node starter application snapshots were proven RTC; the live Worker starter was proven WebSocket, including movement, queued ping once and checkpoint reload. These checks do not certify every device/NAT, durable transport storage or perfect end-to-end playback.

The historical candidate observations below retain the failing observations and progression. The2.1 release evidence remains intact.

## Published package and production acceptance (2026-10-26)

Release `v2.2.0` is published from `64501f4cfe1acf73180f1d5ac93a908a239bf933` by
[trusted publisher run 40375657182](https://github.com/studiokimeiga/twinwire/actions/runs/40375657182).
The [public artifact receipt](release-2.2.0.json) records its SHA256, npm integrity and all 104 distributed-file hashes.
The public tarball is byte-for-byte equivalent to the final candidate's runtime files; wire generation remains 4.

Ten client/server pairs were deployed and checked through their actual public URLs:

| Game | Deployed source | Production acceptance |
| --- | --- | --- |
| CS2 | `d5f929242347bcffd5822c1fc9a2bb476060812e` | Two browsers, RTC/WS movement, firing, once-only actions, same ID and fresh world |
| Nocturne Keep | `5981d659852b6d3a52e62c3a5516d67bd473ec13` | Chromium RTC and phone-sized WebKit WS, private room, night combat, same players/room and fresh world |
| kimu.nyc | `8d9afc8844314899a3cb516159d9e6d64a4ae6db` | Two independent phone-sized browsers, RTC/WS movement, same players and current world after drop |
| Superfighters | `1d498bb0a9eb1fd2eabea50350fed501981ce0d5` | RTC/WS two-player movement, held-input release, same round/host world and terminal return to lobby |
| Emoji Mahjong | `dc21b7ae798eb102232ba48a153c7edeacef8fc4` | Worker WebSocket; desktop/phone Chromium and phone WebKit, private hands, disconnect/reload, original seats and hand IDs |
| Gallax | `f951cba2f5b6efdf5d5ffc0e5a29f79cd379c541` | RTC/WS independent desktop/phone browsers, keyboard movement, peer snapshots, same position and queued chat once |
| Webstrike | `4b4f01f6f16439bce765e076a7b2d118f6790821` | RTC/WS movement, fire, same player, fresh world, terminal player cleanup and continued events |
| Sipoga / NT Web | `71291a75f6d2142dabf6ea24b0044b8824e03f4c` | Public movement/damage/kill/respawn/mobile controls; RTC/WS 8.5-second outage retains player, health and position |
| Wollosseum | `8f27d70451e9024d0df7c227a6d4ac597f190f4f` | RTC/WS two-browser commands and same seat/world after reconnect |
| TDBR | `be4432a205359ccfb2b3ae9534d8060d19f215dc` | RTC/WS independent-browser movement/fire, same player/inventory/world after drop |

Deployment source identifies the tested application artifact; later test/CI-only commits need no game redeployment.
Eight Node backends were additionally inspected over SSH: all 104 installed SDK files match the published tarball.
Mahjong's public JS/CSS bytes match the tested build; its HTML differs only in Windows/Linux line endings.
Fresh game processes report no automatic restarts. Original release directories, process configuration and durable game data remain preserved.

The live Worker starter is version `35f52178-e099-4505-be95-11942e4bf8f2`. Public movement, one queued ping, same-ID recovery
and checkpoint reload pass. The live downloadable Node starter's six extracted files match the clean-tested archive;
its dependency is exactly 2.2.0 and application snapshots were verified over native RTC.

Production acceptance does not erase observed limits. CS2's excluded private weapon icons still return 404;
the movement/fire/reconnect checks pass. Phone-sized automation is not a physical-device certification.
Shared-runner playback includes game CPU work, browser scheduling, intentional buffering and transport delays.
The controlled kimu capture matrix reproduces the former false duplicate sample under both SDK 2.1 and 2.2,
and verifies that the fixed game receiver keeps the two real samples under both SDKs. It preserves the original
capture and codec; it is not a new capture or a native scheduling measurement.

[CS2's independent RTC and WS hour runs](https://github.com/Kimeiga/cs2-ag2-browser/actions/runs/40388683968)
both passed with 57 same-seat recoveries per path and approximately 64 snapshots/second.
[Kimu's 60-minute replay job](https://github.com/Kimeiga/kimu-nyc/actions/runs/40388683897/job/121803640560)
and its stop/reversal/group/pause audits passed with three independent browsers (two native RTC, one forced WS),
133,872–137,278 updates per client, no browser exceptions and zero missing/stale group members across 826,227 checks.
The same workflow's old version-hardcoded preflight failed; the corrected exact-version and controlled capture checks
pass in [separate run 40391431191](https://github.com/Kimeiga/kimu-nyc/actions/runs/40391431191), and the latest PR gate passes.
The application and SDK files are unchanged between these runs. One short shared-runner attempt rejected its own
insufficient update cadence; the unchanged gate passed on another runner. Its failure evidence remains retained.
Nocturne's independent [60-minute network workflow](https://github.com/Kimeiga/nocturne-keep/actions/runs/40391394985)
records its exact source, eight multiplayer suites and repeated drop/pause checks separately from the SDK lifecycle hours.

The kimu replay remains a game-level measurement: physical replay error p99 is about 0.92–1.01 m across pairs,
with a 3.02 m worst scored sample, and recovery/scheduling holds can make declared replay age reach 10.6 seconds.
Raster draws are suppressed in this runner mode; update cadence is not render FPS. These observations are retained,
not relabeled as perfect motion or attributed exclusively to the transport.

## 2.2 candidate verification update (2026-10-26)

Named-channel and Worker host commit 1cdd96f passes hosted Node22/24 core/native/workerd gates and Chromium, Firefox and WebKit normal, impaired, WS-only and party tests in run40336880191. Its two 60-minute soaks were still running at this update. A later configurable named-state age budget passes 152 local checks and requires final hosted validation. Real local ports have passed Wollosseum and nt-web movement/action/resume tests, durable Emoji Mahjong private-hand/restart tests, and Superfighters two-browser gameplay/pause/same-round recovery. These are candidate observations, not a publication/deployment receipt. The original 2.1 evidence and measured 2.0 baseline remain preserved.

# Validation status: 2.1.0 (2026-10-26)

## Combined release validation

The combined runtime at `10fd59ce6bf07d204b696866da697385ffea212c` passes the 2.1.0 release gates.
It includes shared snapshot recovery, continuous online generation-age checks, proven-RTC retry reset and retired-socket
takeover protection. Wire protocol 4 is unchanged. The final documentation update changes no runtime or generated code.

- `npm run check`: **138 tests pass**, including eleven real-WebSocket receiver regressions. The continuous old-payload
  backlog regression was observed failing before its fix. Decoder/reset failure, grouped-stream isolation, new-session
  clock reset, callback generation changes, retained histories, unchanged idle headers and slower-route recovery pass.
- `npm run test:native`: real RTC, fallback and three repeated recoveries pass; retry offers after proven recovery take
  **265.6 / 252.3 / 255.3 ms** for the configured 250 ms base. Duplicate resets do not accumulate retry debt.
- Hosted Node 22 and 24 core checks pass. Chromium, Firefox and WebKit pass normal, impaired and forced-WebSocket
  browser runs plus the party example on both wires. See [final combined run](https://github.com/studiokimeiga/twinwire/actions/runs/40270623290)
  and [ten-minute PR gate](https://github.com/studiokimeiga/twinwire/actions/runs/40270573636).
- Two independent **60-minute** public GitHub-runner lifecycle/hostile-client soaks pass on the final runtime, with
  48 honest and 6 hostile clients per process. Their raw logs and context/source hashes are retained as run artifacts.

| Node | Honest lives | Events sent | States relayed | Mid / late heap median | Worst event-loop p99 |
|---|---:|---:|---:|---:|---:|
| v22.23.3 | 8,851 | 567,850 | 6,176,112 | 9.63 / 10.54 MB | 11.9 ms |
| v24.21.0 | 8,775 | 564,969 | 6,089,926 | 10.01 / 10.93 MB | 11.8 ms |

Both soaks report zero lost/duplicated/reordered echoes in sessions that lived, every honest life online, heap within
the declared stability budget, and no unexpected server errors. Sessions deliberately paused beyond grace can lose
their unacknowledged events. Forged/garbage/oversized/flood traffic creates expected protocol rejections. At drain,
both report **zero sessions, connections, rooms, timers and sockets**. These shared-runner results are lifecycle and
correctness evidence, not independent-machine throughput or physical mobile/radio measurements.

The earlier combined runtime also passed two 60-minute soaks in
[run40267973742](https://github.com/studiokimeiga/twinwire/actions/runs/40267973742); that evidence is preserved separately.
OS namespace UDP-blackhole checks on that combined transport code pass repeat fallback/recovery and 183 once-only
ordered actions with identity/seat retained; the 12 payload/resume/expiry/takeover cases pass with 77 ordered actions.
The subsequent change is confined to the receiver's continuous freshness policy and its regression/documentation.

Game acceptance is recorded in the game repositories and deployment receipts: CS2's 27-shot wire fixture and two
30-minute RTC/WS soaks pass; Nocturne's smoke, eight multiplayer suites and 30-minute RTC/WS drop/pause soak pass.
Kimu's complete-group server correction has separate game regressions and timed verification. A receiver cannot
reconstruct entity records a game server omitted. Game deployments remain a separate paired acceptance step.
Publication is performed by the version-tag trusted-publisher workflow after these checks.

## Prior independent snapshot-recovery validation

The working addition provides `GameClient.receiveState` / `StateReceiver`, with default reset-on-resume or retained
same-session history, and a usable/fresh-state gate independent of connection and clock readiness. Raw APIs and
wire protocol 4 remain unchanged. It is not yet published or adopted by the live games.

Fresh checks on Linux/WSL2, Node 22.21.1, node-datachannel 0.33.4 and Playwright 1.63.0:

- `npm run check`: **136 tests pass**, no skips. Ten new real-WebSocket recovery tests cover retained replay,
  reset-on-resume, new sessions with numerically close clocks, unchanged idle entities, decoder/reset failures,
  future timestamps, callback reentrancy, receiver limits/disposal, grouped snapshot streams and a slower new route.
  The latter learns the new delay while holding its cursor. Targeted regressions were observed failing before their
  corresponding fixes; a reset callback that closes the client also exposed and now prevents a pending welcome
  from overriding that close.
- `npm run test:native`: real datagrams, WebSocket fallback, RTC recovery and the same session pass.
- Browser tests: Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6 pass normally, with 40 ms one-way delay,
  20 ms jitter and 5% loss on each endpoint, and with RTC disabled. Normal runs receive 60/60 states on RTC;
  impaired runs receive 51/53/51 latest-wins states. Reliable events, same session/seat and RTC after resume pass.
- The party example now uses the shared receiver. All three engines pass over WebSocket and RTC: movement,
  prediction agreement, chat and a same-session/seat resume with fresh usable state. No page errors were recorded.

These checks establish the helper's lifecycle contract, not a long hostile soak using the new helper, physical
mobile/radio coverage, or automatic understanding of game physics/delta formats. Current production identities
below refer to the separately deployed 2.0.0 applications. The separately coordinated kimu stop-loss fix/soak is
not part of this library's source or evidence.

## Prior independent RTC/takeover validation

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

## Published 2.0.0 evidence

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
| Production (2.0.0, 2026-10-25) | Nocturne Keep and kimu.nyc have deployed matching client/server pairs on wire 4. Public client files match their built releases, and server health/source identities were checked. Live RTC and forced-WebSocket clients retained player identity and received fresh state after explicit session resumes, with no page errors. Nocturne's smoke plus seven multiplayer suites passed; kimu's combined source passed 139 game and 11 deployment tests. CS2 also deployed its post-lag-compensation-fix source with live RTC/WS gameplay and same-player recovery checks. These applications still use their tested 2.0 adapters; the unreleased shared receiver is not deployed. [Nocturne adoption](https://github.com/Kimeiga/nocturne-keep/pull/8), [kimu adoption](https://github.com/Kimeiga/kimu-nyc/pull/3), [CS2 adoption](https://github.com/Kimeiga/cs2-ag2-browser/pull/5). |
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


## 2.2 product completion candidate — in progress, 2026-10-26

The published 2.1 evidence above remains the release baseline. A separate product-finish branch adds named channel helpers, a pure standard-WebSocket Worker host sharing GameSession/Endpoint, and a complete runnable starter.
The first candidate passed all 149 tests; further auto-connect disposal and pure Worker import/bundle regressions were then added. Individual Worker conformance tests passed over actual sockets. These do not yet establish Cloudflare/workerd execution, native/browser release gates, or completed game migration/deployment. Those remain required before release.

Candidate update: all 151 unit/socket/import tests now pass. A real Miniflare/workerd Durable Object gate also passed binary echo, same-ID resume, ordered offline event replay, session takeover and origin rejection, with zero reported runtime errors. The Worker entry bundles on the browser platform without Node/native imports. A creation-task auto-connect disposal regression failed first, then passed after the queued factory start was fenced against close. Native, multi-browser and longer hosted gates are still pending.

Candidate follow-up: the actual Emoji Mahjong offline/reload browser gate exposed a WebSocket close-handshake stall. A real-socket wrapper regression failed before the fix. Both CLOSING and silently-open faults now pass local retirement, same-ID recovery, stale-callback fencing, ordered action-once and fresh-state hold checks. Full `npm run check` passes 154 tests and the workerd gate passes after the fix; candidate-03 contains these runtime bytes. Final hosted validation is started on a separate ref to preserve earlier runs. This is not yet a published release or production deployment.

Worker compatibility follow-up: a real two-browser hosted-starter check exposed the modern Worker Blob binary default. The actual workerd gate failed before fixes with compatibility2026-03-17 at binary event echo, and compatibility2025-01-01 at prompt close-handshake completion. Both dates now pass binary echo, ordered replay, same-ID recovery, takeover, exact-origin rejection and clean close, with no runtime errors. The paired Worker starter now passes actual browser movement, queued ping once, same-ID reconnect and checkpoint reload. Cloudflare documents the [binary default change](https://developers.cloudflare.com/changelog/post/2026-04-21-websocket-standard-binary-type/) and [older close behavior](https://developers.cloudflare.com/workers/runtime-apis/websockets/). The fix selects ArrayBuffer delivery and replies to close frames in the shared Worker adapter.

All154 local checks pass after this Worker-only fix. Comparing candidate03 with candidate04 proves101 distributed files byte-identical, including every Node/server/client/browser runtime file; only worker.js, its source map and declaration changed. The Node/browser hour soaks at8e79d0f therefore exercise identical Node/browser runtime bytes. Worker behavior is additionally exercised in the real-runtime compatibility matrix. No publication/production receipt is claimed yet.

Starter observations: the complete Node starter passes actual two-browser movement, queued ping once, same-ID reconnect and checkpoint reload with both the current transport and received application snapshots proven RTC. The live Worker starter at twinwire-demo.hak7alp.workers.dev passes the same interactions over WebSocket, with a private arena per invite and version4e66992e-7df7-4e7a-8bbc-97ca8b6eb938. The initial failed live check used an invalid >40-character test invite; the bounded route correctly rejected it. The corrected valid-invite check passes. These are actual hosted-demo observations; SDK npm2.2 publication and game production upgrades are still pending. Mahjong additionally passes WebKit phone-sized recovery and disabled session-storage recovery; physical iPhone coverage is not claimed.
