# twinwire/browser

Everything a page needs in one file, for a script tag or a single-file build: the client, the lobby client and the
netcode. The build targets Safari 15 syntax; tested engines and deployment limits are listed in [verification](/reference/verification).

| File | For |
|---|---|
| `dist/browser/twinwire.min.js` | `<script src>`: defines `window.Twinwire` |
| `dist/browser/twinwire.js` | The same, unminified, with a source map |
| `dist/browser/twinwire.mjs` | An ES module: `import { GameClient } from '.../twinwire.mjs'` |

`import ... from 'twinwire/browser'` resolves to the ES module; `require('twinwire/browser')` gets the script file.

## A script tag

```html
<script src="https://cdn.jsdelivr.net/npm/twinwire@2.2.0/dist/browser/twinwire.min.js"></script>
<script>
  const { GameClient, LobbyClient, Timeline, AdaptivePlayback, lerp } = Twinwire;
  const net = new GameClient({ url: 'wss://play.mygame.com/connect', room: 'mygame' });
  const lobby = new LobbyClient(net);
  net.connect();
</script>
```

Pin the version in the URL, or serve your own copy from `node_modules/twinwire/dist/browser/`.

## What's in it

- Everything in [`twinwire/client`](/reference/api/client): `GameClient`, `LobbyClient`, `BrowserRtcPeer`.
- Everything in [`twinwire/netcode`](/reference/api/netcode).
- From the lobby's shared code: `LOBBY_KEY`, `normalizeCode`, `cleanName`.
- From the protocol: `VERSION`, `MTU_STATE_BYTES` (1086), `DEFAULT_STATE_BYTES` (64 KiB).

The server and the wire-level `Endpoint` aren't in it: the server runs in Node, and `Endpoint` is in the `twinwire`
entry for anyone building their own client.

The explainers on this site import this same file for their browser side.
