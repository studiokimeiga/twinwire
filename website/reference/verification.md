# Compatibility and verification

Twinwire 2.2.0 uses **wire protocol 4** and requires **Node 22+** on a Node server. Native datagrams use
**node-datachannel >=0.33.4 <0.34.0**. Without it, the same session uses WebSocket. Browser entries do not
import Node or native modules.

## What was exercised

The published 2.2.0 release passes 154 local checks, native RTC, and real-server Chromium, Firefox and WebKit tests with normal traffic, impairments and WebSocket-only controls. The party example passes on both paths. Two independent one-hour lifecycle soaks ran on GitHub runners using Node 22 and 24, with 48 honest and six hostile clients per process. Both drained to zero sessions, connections, rooms, timers and sockets, with no unexpected server errors.

The Worker compatibility matrix runs real workerd Durable Objects at both 2025-01-01 and 2026-03-17 compatibility dates: binary state, ordered replay, same-session recovery, takeover fencing, origin rejection and close handshakes. The hosted arena verifies actual movement, a queued ping exactly once, same-player reconnect and checkpoint reload. The complete Node starter also verifies application snapshots over native RTC.

Local game migration checks against the published package exercise retained seats, current worlds, private Mahjong hands, durable game restart, action delivery and independently owned state streams. Each production game rollout is verified separately; the release validation record distinguishes local, published and deployed results.

[Release and source](https://github.com/studiokimeiga/twinwire/releases/tag/v2.2.0) ·
[One-hour verification](https://github.com/studiokimeiga/twinwire/actions/runs/40365174817) ·
[Detailed validation record](https://github.com/studiokimeiga/twinwire/blob/main/validation/STATUS.md) ·
[CI runs](https://github.com/studiokimeiga/twinwire/actions)

## What that does not prove

WebKit automation and phone-sized viewports are not a physical iPhone test. A successful local datagram run
does not certify every NAT, carrier, firewall or TURN provider. Test representative devices and deployment
networks for your game.

End-to-end playback spikes can include network delay, browser scheduling, game CPU work and game interpolation.
Some longer game soaks still contain late frames and scheduling/backlog exclusions. These remain visible in the
validation record; they are not evidence of zero latency or perfect motion.

## Deployment boundaries

The bundled Node server owns in-memory transport sessions. Persistence, account authentication, crash recovery
and routing a resumed session to the same server belong to your deployment. A game can save and restore its
world, but a process restart is not the same as resuming a live transport session.

The separate [`twinwire/worker` host](/reference/api/worker) supports a long-lived Worker or Durable Object over WebSocket. Its transport tokens and replay queues remain in memory; it does not restore hibernated transports. Keep durable worlds and private seat authorization in the game, and explicitly recover a game seat after creating a new transport. Browser clients can be served from static hosts.

## Report a bug

Include the exact Twinwire version, game build, browser/OS, transport, minimal reproduction, expected and
observed behavior, and whether the problem occurs in the starter. Remove resume tokens, account credentials
and private player data before attaching logs.

[Open an issue](https://github.com/studiokimeiga/twinwire/issues/new) · [API contracts](/reference/api/)
