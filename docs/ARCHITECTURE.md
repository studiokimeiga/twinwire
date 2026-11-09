# Architecture and guarantees

## Boundaries

The unit is a **logical session**, not a socket. The server keeps a session's identity and event counters while its
physical connections come and go. Every accepted WebSocket gets a new **epoch**; frames from an older epoch are
ignored on either path. The WebSocket carries control, events and WebRTC signalling; state uses a WebRTC data
channel or optional HTTP/3 WebTransport datagrams when proven, else the WebSocket. Each fast path has independent
probe evidence, payload capabilities and generation fencing; a global primary path need not fit every frame.

```
 game: input, simulation, rendering                   game: rooms, authoritative simulation
              |                                                     |
 GameClient (+ LobbyClient)  <---- one session ---->   GameServer (+ Lobby)
   events: ordered, acked        WebSocket: control, events, signalling, fallback state
   states: latest wins           WebRTC datagrams: state, probes, mirrored events, state acks
```

The application owns authority. The library can't decide whether a position, hit or purchase is legal.

## Connection lifecycle

1. WebSocket: version, origin, room name, authentication; create or resume one session. The welcome carries the
   epoch, a resume token, the ICE servers for this session and the server's event counters, which a client resuming
   from an older checkpoint uses to line up its sequence numbers before it sends anything.
2. Pings estimate the server clock. States aren't sent before the client has an estimate.
3. The client offers an unordered, zero-retransmit data channel (signalled over the WebSocket). The server answers
   from one UDP port shared by every connection.
4. Each side probes the datagram path and needs its own replies back. "Open" isn't proof: one-way loss is caught.
5. State uses datagrams while proof is recent (1.5 s); otherwise the WebSocket. RTC is retried with backoff.
6. A lost WebSocket pauses the session; the client reconnects with its token (backoff from 200 ms, at once when the
   browser reports `online` or the page comes back). The server rechecks authentication and the room/subject
   binding. Unacknowledged events are replayed both ways.
7. After `resumeGraceMs` the session expires. The client must call `newSession()`; old actions are not replayed into
   a new player.

A second tab resuming the same token takes the session over; the first reports session loss rather than fighting.

Transport readiness and world readiness are separate. `GameClient.receiveState` owns the recovery gate for a selected
snapshot stream: disconnect invalidates readiness; a welcome resets or retains application histories by policy;
only a usable, sufficiently recent current-connection snapshot releases playback. The clock estimate is retained
on resume, not used as evidence of fresh world state. Applications provide their decoder and history reset, while
the receiver centralizes the lifecycle. Reliable events and outbound input do not wait behind remote playback.

## Wire protocol (version 5)

Binary frames, little-endian. The header is 12 bytes for streams under 128 (14 at most): one byte with the protocol version (5) in its high nibble and the kind in its low one, the connection's epoch (u16), the stream (a varint of 1 to 3 bytes), the sequence number (u32), and the time as a signed 32-bit count of quarter milliseconds from the connection's time base, which the welcome carries (about six days either way; the server reconnects a connection before that, and it resumes).

| Kind | Path | Meaning |
|---|---|---|
| 1 state | either | Latest-wins application bytes. |
| 6 state-acked | either | The same, and the receiver reports the newest seq it saw. |
| 5 state acks | datagram if up | Pairs of (stream u16, seq u32), at most every 50 ms. |
| 2/3 probe/reply | datagram | Liveness proof and RTT. |
| 4 events | datagram | Copies of WebSocket-sent unacknowledged events (`[[seq, json], ...]`, under 1 KB) and, in the seq field, the sender's own receive ack. |

Control messages are JSON text on the WebSocket: `hello`, `welcome`, `event`, `ack`, `ping`/`pong`, `signal`,
`rtc-reset`, `leave`, `reset`.

## Delivery contracts

### Replaceable state

`sendState` keeps only the newest unsent payload per stream, expires it after `ttlMs`, and sends by priority and age
within the byte budget. Receivers drop anything not newer than what they have on that stream, whichever path it
came by. A payload up to 1086 bytes fits one datagram; larger ones (up to `maxStateBytes`) are fragmented by SCTP on
the datagram path, and anything over `datagramStateBytes` (8 KiB) goes on the WebSocket instead, where a large
snapshot can't be lost piecewise.

Sending is not delivering. Make each payload self-contained or a delta against a snapshot the receiver
**acknowledged** (`ack: true`, `SnapshotHistory`). The WebSocket fallback can't drop queued bytes the way UDP does;
coalescing and the buffer limit keep that backlog short.

### Acknowledged events

Ordered sequence numbers, a bounded outbox, duplicate suppression within a session, replay after reconnects. Every
event goes on the WebSocket; while datagrams are proven, copies are also sent on them and retried at about 1.5×RTT
(six tries). The receiver delivers each seq once, in order, from whichever copy arrives first, holding early ones in a
bounded buffer, and acknowledges on both paths. The result: event latency close to UDP under loss, with TCP as the
guarantee.

An ACK means your callback returned. It isn't a database commit. For purchases and transfers, give the action an id,
persist it with the result, and reply with success or failure.

## Lobby

Rooms are the lobby's, not the transport's: a session joins a room by request (create, code, quick play), keeps a
stable seat across reconnects, and leaves when it asks, is kicked or replaced, or its session expires. Room changes go
to members as `$lobby` events with a view tailored to each (their own seat). Ready-up counts down on the server clock
and starts the room; any change cancels the countdown.

## Performance controls

Simulation, replication and rendering rates are separate (`FixedStepper`). Budgets: per-peer token bucket for
states and events (control and probes are exempt so recovery isn't starved), socket buffer high-water, per-connection
message and byte rate limits on both transports.

## Security

Production needs HTTPS/WSS, exact origins, input validation and, where accounts exist, `authenticate`. Origin isn't
authentication. Resume tokens are bearer secrets. Behind a proxy use `trustProxy` so per-address limits see real
addresses. TURN secrets stay on the server (`turnCredentials` mints short-lived ones). The native adapter keeps DTLS
fingerprint verification on. `allowImpairment` is for development.

## Not here (yet)

Multi-region routing, durable session storage across server restarts, rollback netcode, voice.

## Optional HTTP/3 path and independent resources

The Node host can add WebTransport through an optional native provider. A one-use, time-limited ticket issued by the
live WebSocket binds the HTTP/3 session to its current epoch. One bounded, length-prefixed reliable stream carries
only this binding; ordinary session control and ordered gameplay events remain on WebSocket. Binding confirmation
advertises the verified HTTP/3 listener capability for older browsers missing `reliability`; explicit reliable-only
connections are refused. Neither readiness nor confirmation substitutes for bidirectional datagram probes.

Proven routes are selected with RTT margin/hold hysteresis and complete-message limits. A QUIC datagram cannot rely
on RTC's SCTP fragmentation. A larger state uses another proven RTC path when eligible, then WS. These are measured
selection policies, not a universal QUIC performance claim. Unsupported browser/host capabilities keep the existing
deployment options; pinned Linux WebKit testing covers fallback, not physical Safari's WebTransport implementation.

Bulk resources use separately cancellable HTTP requests with bounded concurrency, allocation and integrity options,
outside ordered gameplay events. Resource versions, chunk subscriptions, durable commits and game authority remain
application responsibilities. Optional diagnostics expose queue/application/playback boundaries with explicit clock
uncertainty and render-submission limits. See [transport and resource controls](TRANSPORTS.md) for APIs and hosting.
