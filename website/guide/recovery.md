# Recover the world, too

<p class="lede">A resumed connection keeps the player. A fresh usable snapshot makes the world ready to play again.</p>

## Two different boundaries

**GameClient.onSession** reports a new or resumed logical session. Same-session event sequence numbers and the
lobby seat survive a temporary disconnect. The browser retries RTC after a failed attempt and can keep using
WebSocket while it does so.

**GameClient.receiveState** owns snapshot recovery. Disconnect invalidates readiness. A welcome resets game
history by default; only an accepted, sufficiently fresh snapshot from this connection makes the receiver ready.
Reliable events and outgoing input continue independently of that playback gate.

~~~js
const receiver = net.receiveState({
  stream: 0,
  reset: () => { history.clear(); deltaBases.clear(); },
  apply: state => {
    const snapshot = decodeWithBase(state.data, deltaBases);
    if (!snapshot) return false;  // malformed data or a missing base cannot release recovery
    history.push(snapshot);
    return true;
  },
});

function frame() {
  if (receiver.ready) draw(history.sample(net.clock.serverTime(performance.now())));
  else drawReconnecting();
}
~~~

The decoder, world history and draw functions above are your game. The [runnable starter](/guide/getting-started)
contains a complete implementation using JSON snapshots.

## Grouped snapshots

For a world split across streams, omit **stream**, reject unrelated or incomplete groups in **apply**, and return
true only after the snapshot group your game requires is usable. One nearby entity packet cannot prove an entire
world is complete. Keep each group and its pending parts bounded.

## Retaining history

Use **resume: 'retain'** only when your same-session interpolation and delta histories remain valid. Readiness
still waits for fresh state. A new session always resets histories. A lost session requires an explicit
**newSession()**; pending actions from the old player must not become actions by a new one.

## Checkpointing reloads

Call **checkpoint()**, store it in sessionStorage or another private per-player store, and restore it into a
new GameClient with the exact same URL and namespace. Bind page lifecycle with **unload: 'pause'** so reloading
keeps the seat during the grace period. Close or leave deliberately when the player chooses to exit.

## Verify your game

Test a short network interruption, page reload, background/foreground transition, blocked datagrams, repeated
RTC failure and reconnect after the grace period. Assert player ID, room, event counts and fresh gameplay
snapshots—not just an open socket. [Sessions demo](/how/sessions) · [Client API](/reference/api/client)
