# Entry points

All modules are ES modules with TypeScript declarations. Browser code never imports the server entry.

| Import | Runs in | What's in it |
|---|---|---|
| [`twinwire/client`](/reference/api/client) | Browser | `GameClient`, `LobbyClient`, `BrowserRtcPeer` |
| [`twinwire/server`](/reference/api/server) | Node 22+ | `createGameServer`, `GameServer`, `GameSession`, `Lobby`, `Room`, `createNativeRtcFactory`, `turnCredentials`, `cloudflareTurn` |
| [`twinwire/netcode`](/reference/api/netcode) | Both | Clock, timing, interpolation, prediction, inputs, snapshots, replication, codecs, spatial |
| [`twinwire/browser`](/reference/api/browser) | Browser | One file with the client, the lobby client and the netcode, for a script tag (`window.Twinwire`) or an `import` |
| `twinwire` | Both | The wire protocol (`encodeFrame`, `decodeFrame`, `FrameKind`, `VERSION`), `Endpoint`, `ReliableEvents`, `TokenBucket`, `estimateEgress`, and the lobby's shared helpers |

The server needs `ws` (installed with Twinwire). WebRTC on the server needs `node-datachannel` 0.33.x, which is
optional: without it, sessions run over the WebSocket only.

## Messages, in one table

| | `sendEvent(json)` | `sendState(stream, bytes, options?)` |
|---|---|---|
| Delivery | Ordered, acknowledged, deduplicated, replayed after reconnects | Latest wins per stream (0 to 65535); older ones dropped |
| Size | JSON up to 64 KiB | Up to `maxStateBytes` (64 KiB; one datagram up to 1086 bytes) |
| Path | WebSocket, with a copy on the datagrams while they are proven | Datagrams while proven, else the WebSocket; over 8 KiB always the WebSocket |
| Receiver | `onEvent(data, seq)`: each event once, in order | `onState({ stream, seq, time, data, via })`: newer than any seen on that stream |
| Options | | `ttlMs` (100), `priority` (1), `ack` (false) |

## Limits worth knowing

- No order holds between events and states. Stamp events with the server tick or a map generation when a snapshot
  depends on them.
- An event is acknowledged when your callback returns, not when a database commits. Give purchases an action id and
  make handlers idempotent.
- Sessions live in the server's memory: a restart starts everyone on a new session.

WebTransport isn't a transport option yet: [why not, and when](/how/two-wires#why-not-webtransport-yet).
