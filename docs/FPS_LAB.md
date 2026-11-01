# FPS lag-compensation lab

This is a small, deliberately game-independent experiment for Twinwire's `SubtickInputBuffer`, `replaySubtick` and `selectRewindTime`.
It provides repeatable peeking/holding test cases and a real WebSocket round trip with authoritative shot verdicts.

## Run

After installing the repository dependencies:

```sh
npm run build
node tools/fps-lab.mjs
node --test test/fps-lab.test.mjs
```

The lab test is also included automatically in `npm test` and `npm run check`.

## What the model measures

- A server-owned 64 Hz timeline with a peeker moving across a wall, then returning behind cover; a holder remains stationary.
- A horizontal ray against a simplified hitbox, with cover and historical positions checked on the server.
- Peeker and holder first-shot times after a fixed 100 ms reaction delay. The holder sees delayed server snapshots; the peeker knows their own position immediately.
- Seeded 0/50/100/200 ms round-trip profiles, plus 20/80 and 80/20 ms directional delays, a high-jitter/high-loss stress case, and an intentionally over-cap 300 ms RTT case.
- Sub-tick fire-edge replay, maximum input age, 250 ms maximum rewind, and a 45 ms client-request tolerance against a server-owned *model* estimate.

The JSON output includes `hitRate`, `rejectRate`, `fallbackRate`, `peekerAdvantageMedianMs`, and `peekerFiredFirstRate`. The advantage is **holder local fire time minus peeker local fire time**, so a positive value means the peeker fired first. These are outcomes of the scripted scenario, not measured fairness or player skill. Null metrics mean no eligible observations.

Snapshots are modeled as lossy, time-delayed deliveries with configurable jitter. Shots are considered reliable and are never randomly dropped; the model does **not** emulate WebSocket retransmissions, congestion, or a complete WebRTC/UDP link. The separate real-transport test uses two actual Twinwire clients and a real local GameServer, introduces asymmetric socket delays and jitter, sends a snapshot and fire command, and checks the server's verdict.

## Trust and applicability

The model uses an **impairment oracle** (known one-way delays and snapshot interval) to derive its independent expected view time. This is a test fixture only. A production server cannot assume it knows a packet's true one-way delay or which snapshot a client rendered. Derive the expected view time from real server-owned observations and bounded policies; never trust the client's timestamp or ACK alone. Also validate weapon fire rate, command ordering, positions, aim, occlusion, and shot age.

No weapon spread, projectile flight, body animation, real map collision, anti-cheat, human reactions, or full game simulation is included. Before tuning OAK-0, run an equivalent harness using its actual physics, weapon rules, snapshot pipeline, rendering/interpolation policy and real network impairment. Do not choose a production rewind cap or claim a fairness improvement from these synthetic results alone.

## Extension

`runTrial(profile, seed)` accepts `{ name, upMs, downMs, jitterMs, snapshotLoss }`; `runMatrix({profiles, trials, seed})` returns JSON-ready summaries. The key assertions in `test/fps-lab.test.mjs` guard determinism, exposure timing, spoofed view times, stale history, invalid input edges, and actual client/server delivery.
