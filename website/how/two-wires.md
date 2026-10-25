# Two wires

<p class="lede">A WebSocket always gets there, but on a lossy network it gets there late. WebRTC datagrams get there
fast or not at all. Twinwire uses both at once, each for what it is good at, and moves between them without the game
noticing.</p>

## Why a WebSocket alone stutters

A WebSocket runs over TCP, and TCP delivers bytes in order. When one packet is lost, every packet behind it waits until
the lost one is resent, even if they arrived fine. That is **head-of-line blocking**. On a phone with a little loss,
a stream of 20 snapshots a second turns into pauses followed by bursts: the stutter players feel.

For game state that is backwards. A position from 200 ms ago is worth nothing once a newer one exists. What state
needs is UDP's behaviour: deliver each packet as soon as it arrives, in any order, and never resend.

Browsers can't open UDP sockets, but a WebRTC data channel can be configured to behave like one: unordered, with no
retransmits. Twinwire's server answers those data channels itself, from one UDP port shared by every player.

## Try it

Two real Twinwire endpoints, a browser's and a server's, exchange snapshots (20 a second), inputs (30 a second) and
the occasional event over a simulated network. The chart underneath shows how long each one took to arrive.

<WiresDemo />

Things to try:

- **Block UDP.** Probes stop coming back, and within 1.5 s of game time the states move to the WebSocket. Then the
  browser tries the datagram path again with backoff: 3 s, 6 s, 12 s and so on, up to 48 s.
- **Now raise the loss to 10%.** Everything rides the WebSocket, so lost segments are resent and the segments behind
  them queue at the receiver. The blue dots in the chart spike to hundreds of milliseconds.
- **Unblock UDP.** At the next retry the path is proven again and the states go back to the datagrams. The amber dots
  stay low however much is lost: a lost datagram is simply gone, and the next one is already on its way.
- **Send an event.** It goes on the WebSocket and a copy races it on the datagrams. Under loss, the copy usually wins.

## Proof, not hope

A data channel that says "open" isn't proof that packets get through. Some networks let the handshake through and then
drop UDP, and some drop it in one direction only.

So each side sends small **probes** on the datagram path every 250 ms and needs its own replies back. A reply proves
the path works both ways and measures its round trip. States use datagrams only while proof is recent: once 1.5 s
pass without a reply, that side drops the path and everything rides the WebSocket. Nothing waits for a timeout to be
noticed by a person.

The browser then retries WebRTC with backoff (from 3 s, doubling up to 48 s, never more than a minute apart), so a
network that recovers gets its fast path back. The game sees one thing throughout: `transport` is `'rtc'` or `'ws'`,
and `onTransport` says when it changes.

## Events at UDP speed

Events must arrive, so they always go on the WebSocket. But while the datagram path is proven, every unacknowledged
event is also copied onto it, and resent there at about 1.5 times the round trip, up to six times. The receiver
delivers each event once, in order, from whichever copy arrives first, holding early ones until the gap fills. It
acknowledges on both paths.

The result: a hit or a door lands at UDP latency when the network is good, and the WebSocket guarantees it when it
isn't. Events of up to about 1 KB take part in the race; bigger ones go on the WebSocket alone.

## State, latest wins

`sendState(stream, bytes)` keeps only the newest unsent payload for each stream. If a newer one is queued before the
old one goes out, the old one is dropped. If it waits longer than its `ttlMs` (100 ms by default), it expires. Queued
states are sent by priority and age within a per-player byte budget, so a slow link gets fewer, fresher snapshots
rather than a growing backlog. Receivers drop anything not newer than what they already have on that stream, whichever
path it came by.

| Size of a state | Where it goes while datagrams are up |
|---|---|
| Up to 1086 bytes | One datagram |
| Up to 8 KiB (`datagramStateBytes`) | Datagrams, fragmented by the data channel |
| Larger, up to 64 KiB (`maxStateBytes`) | The WebSocket, so a big snapshot can't be lost piecewise |

Sending is not delivering. Make each state self-contained, or a delta against one the receiver has acknowledged
([delta snapshots](/how/deltas)).

## Why not WebTransport (yet)?

WebTransport is the newer browser API for UDP-like datagrams, and since Safari 26.4 (March 2026) it is in every major
browser. Twinwire doesn't use it yet, for three reasons:

- **The server side isn't ready in Node.** Node 22 has no built-in QUIC or HTTP/3. The main add-on
  (`@fails-components/webtransport`, built on libquiche) describes itself as a stopgap until Node has native support,
  and its prebuilt binary needs glibc 2.38 or newer, so it fails on Ubuntu 22.04 and Debian 12, the base of the
  `node:22` Docker images.
- **Players wouldn't feel the difference.** Twinwire plays over the WebSocket immediately and upgrades to WebRTC
  datagrams in the background, so WebTransport's faster setup isn't visible.
- **Blocked UDP is already covered.** On networks that block UDP, TURN over TLS on port 443 and the WebSocket already
  get players through.

Once Node ships native WebTransport, Twinwire will add it as another datagram path: preferred where it is available,
with WebRTC and the WebSocket as fallbacks.

## The wire protocol

Binary frames, little-endian. The header is 12 bytes for streams under 128 (14 at most): one byte with the protocol version (4) in its high nibble and the kind in its low one, the connection's epoch (u16), the stream (a varint of 1 to 3 bytes), the sequence number (u32), and the time as a signed 32-bit count of quarter milliseconds from the connection's time base, which the welcome carries (about six days either way; the server reconnects a connection before that, and it resumes).

| Kind | Path | Meaning |
|---|---|---|
| 1 state | either | Latest-wins application bytes |
| 6 state, acknowledged | either | The same, and the receiver reports the newest seq it saw |
| 5 state acks | datagram if up | Pairs of (stream, seq), at most every 50 ms |
| 2, 3 probe and reply | datagram | Proof that the path works, and its round trip |
| 4 events | datagram | Copies of unacknowledged events, and the sender's own receive ack |

Control messages are JSON text on the WebSocket: `hello`, `welcome`, `event`, `ack`, `ping` and `pong`, `signal`,
`rtc-reset`, `leave`, `reset`. Frames from an older epoch are ignored on either path.
