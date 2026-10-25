# Architecture and guarantees

## Boundaries

The unit is a **logical session**, not a socket. The server keeps a session's identity and event counters while its
physical connections come and go. Every accepted WebSocket gets a new **epoch**; frames from an older epoch are
ignored on either path. The WebSocket carries control, events and WebRTC signalling; state uses a WebRTC data
channel when one is proven, else the WebSocket.

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
   epoch, a resume token and the ICE servers for this session.
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

## Wire protocol (version 4)

Binary frames, little-endian. The header is 12 bytes for streams under 128 (14 at most): one byte with the protocol version (4) in its high nibble and the kind in its low one, the connection's epoch (u16), the stream (a varint of 1 to 3 bytes), the sequence number (u32), and the time as a signed 32-bit count of quarter milliseconds from the connection's time base, which the welcome carries (about six days either way; the server reconnects a connection before that, and it resumes).

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

**WebTransport** is in every major browser since Safari 26.4 (March 2026), but not yet in Node: there is no built-in
QUIC/HTTP/3 server, and the addon that provides one (`@fails-components/webtransport`, libquiche) calls itself a stopgap
until Node has native support; its prebuilt binary needs glibc 2.38+, so it fails to load on Ubuntu 22.04 and on
Debian 12 (the `node:22` Docker images). Players wouldn't feel it either: a session plays over the WebSocket at once and
moves to datagrams in the background, so faster setup isn't visible, and where UDP is blocked TURN over TLS 443 and the
WebSocket already carry the game. It will be another datagram path (preferred where available, the data channel and
the WebSocket as fallbacks) once Node ships native WebTransport.
