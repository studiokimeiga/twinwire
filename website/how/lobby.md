# The lobby

<p class="lede">Before anyone plays, they have to find each other: a code to share with a friend, a button that finds a
game with strangers, a seat that is still yours after a dropped connection, and a countdown once everyone is ready.</p>

## Rooms belong to the lobby

The transport knows sessions; the `Lobby` knows rooms. A session joins a room by asking: create one, join one by code,
or quick play. It keeps a stable **seat** in that room across reconnects, and leaves when it asks to, is kicked or
replaced, or its session expires. Every change reaches each member as a view of the room tailored to them (which seat
is theirs), over the same acknowledged events as everything else, so lobby requests survive reconnects too.

## Try it

Four players, each a real `GameClient` with a real `LobbyClient`, and Twinwire's real server-side `Lobby`, all in this
page. SOL runs build 2 of the game; everyone else runs build 1.

<LobbyDemo />

Things to try:

- **Play the walkthrough**, then do it yourself: create a room, copy its code into another player, join.
- **Drop a member's connection** in a room. They show as reconnecting, keep their seat, and lose their ready state.
  A running countdown stops.
- **Leave with everyone.** The empty room stays open for 10 seconds here (30 by default) in case someone comes back by
  code, then closes.
- **Quick play with SOL** while a build 1 room is waiting. Rooms are matched by build, so SOL gets a room of their own.
  Joining a build 1 room by code is refused with the server's message.

## Codes and quick play

**Private rooms** are found only by code: four characters by default (`codeLength`), from an alphabet without I and O
so nobody confuses them with 1 and 0. Codes are case-insensitive.

**Quick play** looks for a public room in the same mode, in a phase that accepts quick play (`quickPlayPhases`, the
waiting lobby by default), with a free seat, whose `meta` matches everything in your `match`, and that your `canJoin`
hook doesn't refuse. Of those, it picks the one with the most connected players, then the newest. If none fits, it
makes a new public room with your `match` in its meta, so the next player with the same build finds it.

```js
await lobby.quickPlay({ mode: 'coop', match: { build: BUILD }, create: { maxMembers: 4 } });
await lobby.create({ mode: 'coop', visibility: 'private', meta: { build: BUILD } });
await lobby.join('KQXT');
```

On the server, `canJoin` is where you keep players of different builds apart, and its message is what the player sees:

```js
const lobby = new Lobby(server, {
  canJoin: (room, session) => room.meta.build !== session.hello?.build ? 'A NEW VERSION IS OUT' : null,
});
```

## Seats and hosts

- A new member takes the **lowest free seat** number. Seats are stable: your seat is yours until you leave or your
  session expires, however many times you reconnect.
- The **host** starts as the room's first member. If the host drops or leaves, the earliest-joined member still
  connected takes over, and keeps the role when the old host comes back. With `allowHostKick`, the host can kick.
- When a room is **full** and someone joins, the member disconnected longest gives up their seat
  (`evictDisconnected`), so a room isn't held hostage by a phone that went away.
- **Drop-in**: rooms can be joined by code while playing (`joinablePhases`, lobby and playing by default).

## Ready, then go

With `ready` on, members say when they are ready. Once every connected member is ready, and there are at least
`minMembers`, the server starts a countdown on its own clock (`countdownMs`, 3 seconds by default) and every member
sees when it ends. It is cancelled when someone unreadies, joins, leaves or drops. When it ends, the room's phase
becomes `playing` and `onStart(room)` is called. `room.setPhase('lobby')` brings everyone back and clears ready.

```js
lobby.onRoom = room => {
  drawMembers(room.members);                      // seat, name, ready, connected, host
  const ms = lobby.countdownMs();                 // null when no countdown is running
  if (ms !== null) showCountdown(Math.ceil(ms / 1000));
  if (room.phase === 'playing') startGame();
};
await lobby.setReady(true);
```

`countdownMs()` compares the room's end time with the page's estimate of the server clock, so every player's
countdown ends together.

## Callbacks

The lobby owns each session's `onEvent` and `onState`, and hands you what you need with the room attached:
`onCreate(room, creator, request)`, `onJoin(room, member)`, `onLeave(room, member, reason)`, `onDisconnect`,
`onReconnect`, `onStart(room)`, `onClose(room, reason)`, `onEvent(room, member, data, session)` and
`onState(room, member, state, session)`. Keep your world in `room.data` and per-player state in `member.data`.

The [server reference](/reference/api/server#lobby) lists every option.
