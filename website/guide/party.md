# The party example

<p class="lede">A complete little game in about 300 lines: quick play or a private room by code, ready-up, then a shared
arena where everyone moves around and chats. The server owns the world; each browser predicts its own player and
interpolates everyone else.</p>

The code is in [`examples/party`](https://github.com/studiokimeiga/twinwire/tree/main/examples/party): `shared.js`
(what both sides run), `server.mjs`, and `index.html`.

```sh
npm install && npm run build
npm run example          # http://127.0.0.1:8790 in two tabs
RTC=1 npm run example    # with WebRTC datagrams (needs node-datachannel)
HOST=0.0.0.0 npm run example   # phones on your network too
```

## What both sides share

The server runs `move()` for real. The browser runs the same function ahead of it, which is what makes prediction
work: if both sides apply the same inputs with the same function, they agree.

```js
// shared.js
export const W = 640, H = 360, SPEED = 160, TICK_HZ = 60, SNAP_HZ = 20, RADIUS = 9;

// one fixed step of one player: input is { dx, dy } in -1..1
export function move(p, input, dt) {
  const len = Math.hypot(input.dx, input.dy);
  if (!len) return { x: p.x, y: p.y };
  const k = Math.min(1, len) / len;
  return { x: clamp(p.x + input.dx * k * SPEED * dt, RADIUS, W - RADIUS), y: clamp(p.y + input.dy * k * SPEED * dt, RADIUS, H - RADIUS) };
}

// an input: two signed bytes (sent in bundles of the last few, so a lost packet costs nothing)
export const inputCodec = defineSchema({ dx: { type: 'i8', scale: 100 }, dy: { type: 'i8', scale: 100 } });
```

A snapshot is the server tick, the last input of yours it applied, then every player as a seat and a position, 5 bytes
each. `encodeSnapshot` and `decodeSnapshot` are plain `DataView` code.

## The server

The lobby is configured for drop-in play: friends can join by code mid-game, and quick play fills games in progress.
Seats and colours are the server's to give, so clients may set no meta of their own.

```js
const lobby = new Lobby(server, {
  maxMembers: 8,
  ready: { countdownMs: 3000, minMembers: 1 },
  joinablePhases: ['lobby', 'playing'],            // friends can join by code mid-game
  quickPlayPhases: ['lobby', 'playing'],           // and quick play fills games in progress too
  clientMetaKeys: [],                              // seats and colours are the server's to give
});

lobby.onCreate = room => { room.data = { tick: 0, players: new Map() }; };
lobby.onJoin = (room, m) => {
  m.data = { ...spawn(m.seat), seat: m.seat, inbox: new InputInbox(), last: { dx: 0, dy: 0 }, newest: 0 };
  room.data.players.set(m.seat, m.data);
  room.broadcast({ t: 'chat', from: '', text: `${m.name} joined` });
};
```

Inputs come in on stream 1 as bundles of the last few. `InputInbox` takes each one once, in order, however many
copies arrive:

```js
lobby.onState = (room, m, st) => {
  if (!m?.data || st.stream !== 1) return;
  for (const i of decodeInputs(st.data) ?? []) {
    const v = inputCodec.decode(i.data); if (!v) continue;
    m.data.inbox.add({ seq: i.seq, value: v }); m.data.newest = Math.max(m.data.newest, i.seq);
  }
};
```

Chat is an event: validated, then passed on with `room.broadcast`, which reaches disconnected members too when they
come back.

```js
lobby.onEvent = (room, m, data) => {
  if (!room || !m || !data || data.t !== 'chat' || typeof data.text !== 'string') return;
  const text = data.text.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (text) room.broadcast({ t: 'chat', from: m.name, seat: m.seat, text });
};
```

The world steps 60 times a second and sends a snapshot 20 times a second. A player far behind (a stall, a burst
after a hiccup) jumps to their newest inputs rather than replaying old movement:

```js
setInterval(() => {
  for (const room of lobby.rooms.values()) {
    const W = room.data; if (!W || room.phase !== 'playing') continue;
    W.tick++;
    for (const p of W.players.values()) {
      if (p.newest - p.inbox.applied > 10) p.inbox.skipThrough(p.newest - 3);
      const i = p.inbox.next();
      if (i) p.last = i.value;
      Object.assign(p, move(p, i ? i.value : p.last, 1 / TICK_HZ));
    }
    if (W.tick % (TICK_HZ / SNAP_HZ)) continue;
    const list = [...W.players.values()];
    for (const m of room.members.values())
      if (m.connected && m.data) m.session.sendState(0, encodeSnapshot(W.tick, m.data.inbox.applied, list), { ttlMs: 100 });
  }
}, 1000 / TICK_HZ);
```

## The page

One `GameClient` and one `LobbyClient`. `?ws` in the address turns WebRTC off, to see the WebSocket-only path.

```js
const client = new GameClient({ url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/connect`, room: 'party', rtc: params.has('ws') ? false : {} });
const lobby = new LobbyClient(client);
client.bindPageLifecycle();

$('quick').onclick = () => go(name => lobby.quickPlay({ mode: 'party', name }));
$('create').onclick = () => go(name => lobby.create({ mode: 'party', name }));
$('join').onclick = () => go(name => lobby.join($('code').value, { name }));
```

When a snapshot arrives, your own player is reconciled: the server's position, with the inputs it hasn't applied yet
replayed on top. Everyone else goes into a `Timeline` to be drawn a little in the past.

```js
client.onState = s => {
  if (s.stream !== 0 || !lobby.room) return;
  const snap = decodeSnapshot(s.data); if (!snap) return;
  if (client.clock.synced) playback.observe(client.clock.serverTime(performance.now()), s.time);
  for (const p of snap.players) {
    if (p.seat === lobby.room.you) {
      if (!me || snap.ack > me.lastInput) { me = me || new Predictor({ x: p.x, y: p.y }, move, 1 / TICK_HZ); me.resync({ x: p.x, y: p.y }, snap.tick, snap.ack); }
      else me.reconcile({ ack: snap.ack, tick: snap.tick, state: { x: p.x, y: p.y } });
      continue;
    }
    let o = others.get(p.seat); if (!o) others.set(p.seat, o = new Timeline(32));
    o.insert({ time: s.time, seq: snap.tick, value: { x: p.x, y: p.y } });
  }
};
```

Each fixed step pushes one input into the predictor and sends the last six, so one lost packet never loses a step:

```js
stepper.advance(dt, () => {
  if (!playing) return;
  const v = input(), q = { dx: Math.round(v.dx * 100) / 100, dy: Math.round(v.dy * 100) / 100 };
  me.push(q);
  client.sendState(1, encodeInputs(me.recent(6).map(i => ({ seq: i.seq, data: inputCodec.encode(i.value) }))), { ttlMs: 50 });
});
```

And each frame draws everyone else at the playback time, and you where you predict yourself:

```js
const t = client.clock.synced ? playback.advance(client.clock.serverTime(now), dt) : 0;
for (const [seat, tl] of others) {
  const s = tl.sample(t, (a, b, u) => ({ x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u) }));
  if (s) draw(seat, s.value, false);
}
if (me) draw(room?.you ?? 0, me.state, true);
```

The three ideas in play here each have a page: [prediction and reconciliation](/how/prediction),
[snapshot interpolation](/how/interpolation) and [the lobby](/how/lobby).
