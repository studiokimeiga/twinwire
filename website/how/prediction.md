# Prediction and reconciliation

<p class="lede">If your own player moved only when the server said so, every keypress would take a round trip to show.
Instead the browser moves you at once, using the same rules as the server, and quietly corrects itself when the server
disagrees.</p>

## Three ideas

**Prediction.** Each input is applied locally the moment it happens, with the same step function the server runs.
The input also goes to the server, numbered.

**Authority.** The server applies inputs in order, one per step, and is the only one whose result counts. With each
snapshot it says which of your inputs it has applied so far: the **ack**.

**Reconciliation.** When a snapshot arrives, the browser starts from the server's state, drops the inputs the server
has already applied, and replays the rest on top. If both sides agree, nothing visible happens. If they don't (a
collision the browser couldn't know about, a push from another player), the correction lands in one step.

## Try it

A real `Predictor` in the browser, a real `InputInbox` on the server, inputs sent in bundles with `encodeInputs`, and a
`defineSchema` codec of two bytes per input. The server's rules are the party example's.

<PredictionDemo />

Things to try:

- **Turn prediction off.** You move only when the server's snapshot comes back: a round trip plus up to a snapshot
  interval after every input, and the motion steps at 20 updates a second.
- **Turn reconciliation off** (with prediction on). Each snapshot resets you to where the server had you, losing the
  inputs still in flight. You get pulled back every time a snapshot lands.
- **Turn on the wind.** The server pushes you down inside the band, and the browser doesn't know. Reconciliation
  corrects you each time you cross it: the red flashes.
- **Raise the loss with one input per packet.** Lost inputs leave gaps the server waits on, then gives up on. With four
  or more per packet, a lost packet costs nothing: the next one carries the same inputs.

## In the browser

```js
import { Predictor, FixedStepper, encodeInputs, defineSchema } from 'twinwire/netcode';

const inputCodec = defineSchema({ dx: { type: 'i8', scale: 100 }, dy: { type: 'i8', scale: 100 } });
const me = new Predictor({ x: 0, y: 0 }, move, 1 / 60);   // move(state, input, dt): the same function as the server's
const stepper = new FixedStepper(60);

function frame(dt) {
  stepper.advance(dt, () => {
    me.push(readInput());                                  // predicted at once
    const bundle = encodeInputs(me.recent(6).map(i => ({ seq: i.seq, data: inputCodec.encode(i.value) })));
    net.sendState(1, bundle, { ttlMs: 50 });               // the last six, so one lost packet loses nothing
  });
  draw(me.state);
}

net.onState = s => {
  const snap = decodeSnapshot(s.data);                     // { tick, ack, mine: { x, y }, ... }
  me.reconcile({ ack: snap.ack, tick: snap.tick, state: snap.mine });
};
```

`reconcile` ignores a snapshot whose tick isn't newer than the last one it used, so late snapshots can't move you
backwards in time. `resync(state, tick, ack)` starts over from the server's word, for a respawn or a new session.

## On the server

```js
import { InputInbox, decodeInputs } from 'twinwire/netcode';

member.data.inbox = new InputInbox();

lobby.onState = (room, member, st) => {
  if (st.stream !== 1) return;
  for (const i of decodeInputs(st.data) ?? []) {           // each bundle repeats the last few inputs
    const v = inputCodec.decode(i.data);
    if (v) member.data.inbox.add({ seq: i.seq, value: v }); // duplicates and old ones are ignored
  }
};

// each step: the next input in order, or the last one again if it hasn't arrived
const next = member.data.inbox.next();
if (next) member.data.last = next.value;
step(member.data, member.data.last);
// with each snapshot: member.data.inbox.applied is the ack
```

`InputInbox` hands inputs out strictly in order. If one never arrives, it waits. Deciding when to give up is game
policy, so it is never automatic: the party example calls `skipThrough(newest - 3)` when it falls more than ten inputs
behind, jumping to the newest few rather than replaying old movement.

## Fixed steps

Prediction only works if both sides step the same way. `FixedStepper(hz, maxCatchUp)` runs your step function at a
fixed rate however the frames fall, catches up at most `maxCatchUp` steps at a time, and reports the time it had to
drop (`droppedMs`, `overruns`) instead of spiralling. `alpha` is how far the next step is, for drawing between steps.

## Shots and lag compensation

A player aims at other players as they saw them: in the past, by their interpolation delay. To judge a shot fairly,
the server rewinds the targets to the time the shooter saw. `rewindTime(requested, now, maxRewindMs)` clamps that
request to a window you allow, so nobody can claim a shot from long ago. The hit test itself is your game's: a shot
that matters is an event naming the input or tick it came from, and the server checks it against its own history.
