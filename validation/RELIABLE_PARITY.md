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

## Completed candidate comparison

The [96a0ad9 workflow](https://github.com/studiokimeiga/twinwire/actions/runs/41919352005)
completed successfully in all four browser/path jobs: **80 valid trials, 40 pairs**.
Every minute-long overload pair met both thresholds. Normal controls remained
approximately unchanged and did not qualify as a repeated latency improvement.

| Browser / path | Median p95 age, 2.3 → candidate | Median paired age change | Median reliable events / minute |
| --- | ---: | ---: | ---: |
| Chromium / WS | 171.4 → 140.1 ms | −18.0% | 323 → 331 |
| Chromium / RTC | 170.9 → 140.2 ms | −17.8% | 323 → 331 |
| Firefox / WS | 172.3 → 140.9 ms | −18.2% | 323 → 331 |
| Firefox / RTC | 171.4 → 141.1 ms | −17.3% | 323 → 331 |

Before/after values are independent medians; paired changes summarize individual
ratios. This is state generation to Canvas draw submission with clock estimates,
not packet transit or physical display latency. The flood still rejects thousands
of attempts at its bounded outbox and queues accepted events for tens of seconds;
delivering more of them does not make this deliberately overloaded application
healthy. Games should keep bulk resources out of ordered events and admit commands
within sustainable capacity.

This setting improves both measures relative to 2.3 in this workload. It delivers
fewer, regularly paced states than the state-oriented 3.0 default under the flood;
it does **not** establish the full original 66% state-age improvement at unchanged
event throughput. Real-game FPS and gameplay acceptance require separate evidence.
