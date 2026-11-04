# Compatibility and verification

Twinwire 3.0.0 uses **wire protocol 5** and requires **Node 22+** on a Node server. Deploy matching browser and
server versions together; 2.x clients are not wire-compatible. Native RTC uses **node-datachannel >=0.33.4 <0.34.0**.
Optional WebTransport uses a separately configured HTTP/3 provider and listener. Both paths need two-way proof;
the session retains WebSocket fallback. Browser and Worker entries do not import Node or native modules.

## What was exercised

The 3.0 runtime passes 232 local checks, native RTC and real-server Chromium, Firefox and WebKit tests with normal
traffic, impairments and WebSocket-only controls. The party example passes on both paths. Actual Chromium and
Firefox WebTransport exercises require received application states, RTC/WS fallback, concurrent HTTP resources
and game commands, and same-session recovery. Pinned Linux WebKit covers fallback, not native QUIC.

Publication requires all jobs in the [final runtime run](https://github.com/studiokimeiga/twinwire/actions/runs/41777183172)
and final PR gates to succeed. The run includes independent one-hour Node22/24 WebSocket lifecycle soaks and
Chromium/Firefox native QUIC lifecycle soaks. The [validation record](https://github.com/studiokimeiga/twinwire/blob/main/validation/STATUS.md)
and [raw measurements](https://github.com/studiokimeiga/twinwire/blob/main/validation/transport-3.0.0.json) identify
the exact tested runtime, distributed-file hashes, controlled 2.3 comparison, tracing overhead and clock uncertainty.

The Worker compatibility matrix runs real workerd Durable Objects at both 2025-01-01 and 2026-03-17 compatibility dates: binary state, ordered replay, same-session recovery, takeover fencing, origin rejection and close handshakes. The hosted arena verifies actual movement, a queued ping exactly once, same-player reconnect and checkpoint reload. The complete Node starter also verifies application snapshots over native RTC.

Production acceptance is separate from SDK validation. The previous 2.2 rollout verified ten paired games through
their public URLs: movement/actions, same-session reconnects and current-world presentation on native RTC and forced
WebSocket for the Node games. Emoji Mahjong preserves private hands and seats through disconnect and reload in
desktop Chromium, phone-sized Chromium and phone-sized WebKit. Each newer rollout needs its own matching client,
server and acceptance receipt. [Try the live integrations](/demos#live-game-integrations).

The starter checks use real movement, an offline queued ping exactly once, same-player reconnect and checkpoint
reload. Public-download verification compares its files with the clean-installed tested project. The release record
separates SDK lifecycle soaks, game replay measurements and production acceptance.

[Release and source](https://github.com/studiokimeiga/twinwire/releases/tag/v3.0.0) ·
[One-hour verification](https://github.com/studiokimeiga/twinwire/actions/runs/41777183172) ·
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
