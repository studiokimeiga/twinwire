# Reliable throughput and state freshness

The published 3.0 comparison delivered fresher states under a deliberately overloaded
4,000 B/s application budget, but received 60 instead of 65 reliable events per 12 seconds.
That measured tradeoff remains in the release evidence. Extra snapshots consume real bytes;
the same uncompressed payloads cannot fit unlimited traffic into a fixed rate.

This follow-up tests an event-throughput-oriented setting, `stateBudgetShare: 0.075`,
with a correction to oversized-event debt repayment. The default state share remains 0.5.
The lower share allows fewer state updates than the 3.0 default in this overload; the
claim under test is lower age than 2.3 **without fewer reliable events**, not retaining
the entire earlier 66% age improvement or giving every game a universal preset.

An oversized event previously waited for its class bucket to fill on every grant.
When a pump crossed that boundary, refill credit above the capacity was clipped.
Repeated clipping left bandwidth unused even with an event continuously waiting.
The corrected event shaper grants one oversized packet after the previous packet's
debt is repaid. Its byte rate is unchanged; debt is bounded by one complete event.
State eligibility and positive-credit borrowing protections remain unchanged.
A 60-second fixed-clock regression requires at least 325 680-byte events from a
3,700 B/s event share: the previous implementation delivered 316. Every prefix is
checked against rate plus starting credit and one packet of debt. Failed writes
must still refund their debits and preserve ordered delivery.

## Predeclared browser protocol

Use the unchanged published 2.3 archive from the original comparison. Candidate
runtime file hashes and the exact source/harness revisions are recorded per run.
Use the same real Canvas scene, payloads, offered rates, byte rate, burst, clocks,
fresh browser/server, alternating order and actual-path checks documented in
[BROWSER_PERFORMANCE.md](BROWSER_PERFORMANCE.md). Only the candidate authority's
state share changes to 0.075; clients retain defaults.

- Chromium and Firefox, forced WebSocket and proven native RTC, independently.
- Five paired 12-second normal-traffic controls per browser/path.
- Five paired **60-second** mixed-budget trials per browser/path, after warmup.
- Lower p95 draw-submission state age by at least 10% in every pair, beyond both
  reported clock estimates; receive **at least as many ordered events in every pair**.
- Preserve every outcome, including failures, event counts/rejections/age, state
  deliveries, server CPU, frame tails and actual encoded-byte observations.
- Count budgeted primary bytes from actual first reliable sends and state frames.
  Check configured rate plus burst and bounded oversized-packet debt. Also retain
  total encoded bytes, including exempt control and mirrored datagram traffic.
- No new FPS claim from the Canvas scene. Profile and benchmark actual rendered
  games separately; preserve vsync/renderer limits and use unchanged scene work.

The minute-long window checks sustained service rather than a fortunate initial
burst. The completed workflow, not this proposed protocol, determines whether the
candidate qualifies. Pilot attempts and a rejected broader state-debt change are
retained separately. No wire-format change is proposed.
