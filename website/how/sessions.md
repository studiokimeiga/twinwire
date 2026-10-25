# Sessions that survive

<p class="lede">A phone in a game is not a stable thing. It goes through tunnels, switches from Wi-Fi to cellular,
locks its screen, and gets swapped to another app mid-match. Twinwire's unit is the player's session, not the
connection, so a player who drops comes back as themselves.</p>

## One session, many connections

When a page connects, the server creates a **session**: an identity, a resume token, and counters for the events in
each direction. The session outlives its connections. Every time the page reconnects, it presents the token and gets
the same session back on a new connection, with a new **epoch** number so nothing from the old connection can be
mistaken for the new one.

While the connection is down, nothing is forgotten:

- The page keeps every event it sent that the server hasn't acknowledged, and sends them again once it is back.
- The server does the same in the other direction.
- Each event is delivered exactly once, in order, however many times it was sent.
- In the lobby, the player keeps their seat. Others see them as reconnecting, not gone.

The server holds the session for `resumeGraceMs` (90 seconds by default). After that it is gone: the seat is freed,
and a page that comes back is told its session expired. It then starts a new session explicitly. Old actions are
never replayed into a new player.

## Try it

The page below runs Twinwire's real `GameServer` and `GameClient`. Only the network between them is simulated. The
browser sends an event every second, as a game would for steps, shots and doors.

<SessionsDemo />

Things to try:

- **Drop the connection.** The page reconnects within a fraction of a second, the epoch goes up, and the events keep
  landing.
- **Turn the phone offline** for a few seconds. Connection attempts fail and back off (200 ms, doubling, up to 8 s).
  Events pile up in the outbox. When you turn it back on, they arrive in one burst, in order: the long lines.
- **Stay offline longer than the seat is held.** The server expires the session. When the phone comes back, the page
  learns its session is gone and the events it was holding stay with it. Start a new session to play on.
- **Put the app in the background.** The page closes its connection on purpose and keeps its session. Coming back
  resumes it.

## The connection's life

1. **Hello.** The WebSocket opens and the page sends a hello with the protocol version, the room namespace, its
   resume token (if it has one) and your `auth` JSON. The server checks the origin, the version and your
   `authenticate` hook, then creates or resumes the session. The welcome carries the epoch, the resume token and the
   ICE servers for WebRTC.
2. **Clock.** Pings estimate the server's clock. States aren't sent before the page has an estimate.
3. **Datagrams.** The page offers a WebRTC data channel and both sides prove it works. That's the
   [two wires](/how/two-wires) page.
4. **Trouble.** A lost WebSocket pauses the session. The page reconnects with its token, backing off from 200 ms, or
   at once when the browser reports it is back online or the page comes back to the foreground. The server checks
   authentication again, and that the token belongs to the same room and subject. Unacknowledged events are replayed
   both ways.
5. **Expiry.** After `resumeGraceMs` without a connection the session expires. The page reports `onSessionLost` and
   stops retrying until you call `newSession()`.

A second tab resuming the same token takes the session over. The first tab is told it was replaced, and reports
session loss instead of fighting for it.

## In your code

```js
const net = new GameClient({ url, room: 'mygame' });

net.onSession = ({ id, resumed }) => {
  if (!resumed) resetGame();        // a brand-new session: nothing of the old one survives
};
net.onStatus = status => showConnection(status);   // connecting, online, paused, lost, closed
net.onSessionLost = ({ reason, pendingEvents }) => {
  showMessage(`Disconnected: ${reason}`);           // expired, kicked, replaced by another tab...
  offerButton('Play again', () => net.newSession());
};
```

On the server, a lobby member keeps its seat while disconnected. `onDisconnect` and `onReconnect` tell you when to
pause their character and when to send a fresh client whatever it needs to redraw the world:

```js
lobby.onDisconnect = (room, member) => room.data.freeze(member.seat);
lobby.onReconnect = (room, member) => member.session.sendEvent({ t: 'world', ...room.data.fullState() });
```

## Coming back to the foreground

`bindPageLifecycle()` handles what mobile browsers do to background pages:

- The page pauses when it is hidden for 20 seconds (`hiddenPauseMs`), or at once when it is unloaded or put in the
  back-forward cache.
- When it comes back, a paused session resumes. A connection that looks open but says nothing for 1.5 s
  (`wakeCheckMs`) is replaced; after a phone sleeps, that is the usual case.
- When the browser says the network is back (`online`), it reconnects without waiting for the backoff.

## Surviving a reload

`checkpoint()` captures the session (its token and the events not yet acknowledged) so a reloaded page can resume it
and keep its seat. It holds a bearer token: keep it in `sessionStorage`, never in a URL.

```js
const saved = sessionStorage.getItem('net');
const net = new GameClient({ url, room: 'mygame', checkpoint: saved ? JSON.parse(saved) : undefined });
addEventListener('pagehide', () => {
  const cp = net.checkpoint();
  if (cp) sessionStorage.setItem('net', JSON.stringify(cp));
});
```

The constructor refuses a checkpoint made for a different URL or room.

## What an acknowledgement means

The server acknowledges an event when your `onEvent` callback returns without throwing. That is not a database
commit. For purchases and transfers, give each action an id, store it with its result, and reply with success or
failure, so a replayed action is recognised rather than applied twice.

Sessions live in the server's memory. A server restart loses them, so a deploy should expect every player to start a
new session, and your game should be able to send a full state to a fresh client.
