# Rendered browser comparison protocol

This experiment compares published Twinwire 2.3.0 with the 3.0.0 runtime in a small authoritative Canvas scene.
It can demonstrate a repeatable improvement in a defined workload. It cannot establish universally lower
latency, physical display latency, production-game GPU FPS, or performance on untested devices and networks.

## Fixed conditions

- Chromium and Firefox, each tested independently over WebSocket and actual native WebRTC.
- Five paired 12-second trials per workload, alternating version order. Every sample starts a new browser and
  server process, proves the requested path and synchronizes its clock, then warms up for two seconds.
- The same 20-byte self-contained state at 20 Hz, 40 ms TTL, and default 60 Hz endpoint pump for both SDKs.
- `normal`: 240 rendered entities and a 256 KiB/s application byte budget.
- `mixed-budget`: the same rendering, 4,000 B/s budget and 200-byte burst, plus 100 attempted 600-character
  events per second. This intentionally exceeds capacity. Event throughput, latency and bounded outbox rejections
  are retained alongside state delivery. This tests application scheduling, not physical TCP loss/congestion.
- `render-load`: the normal network workload with 12,000 Canvas rectangles drawn on every frame. No raster calls
  are suppressed. Rendering and simulation code are identical across SDK versions.

The immutable baseline archive must have SHA-256
`5fd06c1f96c6506b63153c1ab32913f04a262d8eaeb4f30e20d5c3dc99b6fda2`. Each report identifies the harness,
browser build, CPU, Node version, runtime file hashes, workload and every successful trial. A failed fixture leaves
its failure artifact and fails the job; a neutral performance result is valid and stays in the report.

## Measurements and decision rules

Receipt age is sampled when JavaScript accepts a state. Draw-submission age is sampled after the corresponding
Canvas work. Both use the estimated server clock and retain its uncertainty. The previous submitted snapshot's
age is also measured before the next draw so frame gaps remain visible. These marks do not measure GPU presentation.

Frame cadence counts animation callbacks while performing the real drawing work. Frame-interval percentiles,
actual draw counts and changed Canvas pixels accompany it. Server CPU is measured in its separate process;
it is not total browser/game CPU. No frame or latency observations are silently discarded from a valid sample.

The comparison only labels a repeated latency benefit when all five pairs improve p95 draw-submission age by
at least 10% and the difference exceeds both reported clock-uncertainty estimates. A repeated scene-cadence gain
requires at least 5% in every pair. These are predeclared engineering thresholds, not statistical population
confidence intervals. Raw values and tradeoffs remain available even when a threshold is not met.

## Reproduce

After installing and building the SDK, extract the verified 2.3.0 package and give it access to the same `ws`
and optional native RTC dependencies. Install Playwright's selected engine, then run:

```sh
node tools/browser-performance.mjs --baseline /absolute/path/to/2.3.0/package \
  --engine chromium --transport rtc --seconds 12 --repetitions 5
node tools/summarize-browser-performance.mjs artifacts/browser-performance/report-chromium-rtc.json
```

The `Rendered browser performance comparison` Actions workflow runs all four engine/path combinations
on separate Ubuntu 24.04 runners and retains JSON reports and screenshots. It runs on harness changes in the
benchmark branch and supports manual dispatch once merged. QUIC functionality and lifecycle
coverage remain in the separate native WebTransport gates; this comparison does not attribute their results to QUIC.
