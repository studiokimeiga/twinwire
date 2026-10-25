<script setup lang="ts">
// Twinwire's real server Lobby on the real GameServer, with four players, each a real GameClient + LobbyClient,
// across a simulated network.
import { onMounted, onBeforeUnmount, reactive, ref } from 'vue';

interface Member { seat: number; name: string; ready: boolean; connected: boolean; host: boolean }
interface View { code: string; mode: string; visibility: string; phase: string; maxMembers: number; meta: Record<string, unknown>; you: number; members: Member[]; countdownEndsAt: number | null }
interface Player { name: string; build: number; status: string; room: View | null; error: string; countdown: number | null; code: string; busy: boolean }
interface ServerRoom { code: string; visibility: string; build: unknown; phase: string; seats: number; max: number; closesIn: number | null }

const players = reactive<Player[]>([
  { name: 'WREN', build: 1, status: 'idle', room: null, error: '', countdown: null, code: '', busy: false },
  { name: 'PIP', build: 1, status: 'idle', room: null, error: '', countdown: null, code: '', busy: false },
  { name: 'MOSS', build: 1, status: 'idle', room: null, error: '', countdown: null, code: '', busy: false },
  { name: 'SOL', build: 2, status: 'idle', room: null, error: '', countdown: null, code: '', busy: false },
]);
const rooms = ref<ServerRoom[]>([]);
const story = ref('');
const ready = ref(false);
let api: {
  create(i: number): Promise<void>; join(i: number): Promise<void>; quick(i: number): Promise<void>;
  setReady(i: number): Promise<void>; leave(i: number): Promise<void>; drop(i: number): void; walkthrough(): Promise<void>;
} | null = null;
let stop = () => {};

onMounted(async () => {
  const [{ LiveNet, LIVE_URL }, { Lobby }, { GameClient, LobbyClient }] = await Promise.all([
    import('../../lib/livenet'), import('twinwire/server'), import('twinwire/browser')]);
  const net = new LiveNet({ resumeGraceMs: 20000 });
  net.latency = 50; net.jitter = 10;
  const lobby = new Lobby(net.server, {
    maxMembers: 4, emptyCloseMs: 10000,
    ready: { countdownMs: 3000, minMembers: 2 },
    canJoin: (room, session) => room.meta.build !== (session.hello as { build?: number } | null)?.build ? 'that room runs another version of the game' : null,
  });
  // a round lasts five seconds, then everyone is back in the room's lobby
  lobby.onStart = room => { setTimeout(() => { if (!room.closed) room.setPhase('lobby'); }, 5000); };
  await net.start();

  const clients = players.map((p, i) => {
    const client = new GameClient({ url: LIVE_URL, room: 'lobby-demo', rtc: false, websocket: net.websocket, auth: { name: p.name, build: p.build } });
    const lc = new LobbyClient(client);
    client.onStatus = st => { players[i]!.status = st; };
    lc.onRoom = room => { players[i]!.room = room as View | null; };
    lc.onLeft = reason => { players[i]!.error = `left the room: ${reason}`; };
    client.connect();
    return { client, lc };
  });
  const act = async (i: number, fn: () => Promise<unknown>) => {
    const p = players[i]!; p.error = ''; p.busy = true;
    try { await clients[i]!.client.whenOnline(); await fn(); } catch (e) { p.error = (e as Error).message; } finally { p.busy = false; }
  };
  const meta = (i: number) => ({ build: players[i]!.build });
  api = {
    create: i => act(i, () => clients[i]!.lc.create({ mode: 'coop', visibility: 'private', meta: meta(i), name: players[i]!.name })),
    join: i => act(i, () => clients[i]!.lc.join(players[i]!.code, { name: players[i]!.name })),
    quick: i => act(i, () => clients[i]!.lc.quickPlay({ mode: 'coop', match: meta(i), name: players[i]!.name })),
    setReady: i => act(i, () => clients[i]!.lc.setReady(!clients[i]!.lc.me?.ready)),
    leave: i => act(i, () => clients[i]!.lc.leave()),
    drop: i => clients[i]!.client.simulateDrop(),
    async walkthrough() {
      const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 4; i++) if (players[i]!.room) await api!.leave(i);
      story.value = 'WREN makes a private room. Only its code gets you in.'; await api!.create(0); await wait(1400);
      const code = players[0]!.room?.code ?? '';
      players[1]!.code = code; story.value = `PIP joins with the code ${code}.`; await api!.join(1); await wait(1400);
      story.value = 'MOSS presses quick play. Private rooms are never matched, so a new public room opens.'; await api!.quick(2); await wait(1600);
      story.value = 'SOL presses quick play too, but runs build 2: the public room is for build 1, so SOL gets a room of their own.'; await api!.quick(3); await wait(1800);
      story.value = 'WREN and PIP get ready. With everyone ready, the server counts down and starts the room.';
      await api!.setReady(0); await wait(700); await api!.setReady(1);
    },
  };
  ready.value = true;
  const timer = setInterval(() => {
    players.forEach((p, i) => {
      const ms = clients[i]!.lc.countdownMs(); p.countdown = ms === null ? null : Math.ceil(ms / 100) / 10;
      if (!p.code && i > 0) { const open = players.find(q => q.room?.visibility === 'private'); if (open) p.code = open.room!.code; }
    });
    rooms.value = [...lobby.rooms.values()].map(r => ({
      code: r.code, visibility: r.visibility, build: r.meta.build, phase: r.phase, seats: r.members.size, max: r.maxMembers,
      closesIn: r.members.size === 0 && r.emptySince !== null ? Math.max(0, Math.ceil((10000 - (Date.now() - r.emptySince)) / 1000)) : null,
    }));
  }, 100);
  stop = () => { clearInterval(timer); for (const c of clients) c.client.close(); lobby.dispose(); net.stop(); };
});
onBeforeUnmount(() => stop());
const state = (m: Member) => !m.connected ? 'reconnecting' : m.ready ? 'ready' : 'not ready';
</script>

<template>
  <figure class="tw-demo lobby-demo" aria-label="Four players and a lobby server">
    <div class="lobby-top">
      <button class="tw-btn primary" type="button" :disabled="!ready" @click="api?.walkthrough()">Play the walkthrough</button>
      <p class="story" aria-live="polite">{{ story || 'Four players on one server. Make rooms, share codes, quick play and ready up, or play the walkthrough.' }}</p>
    </div>
    <div class="phones">
      <section v-for="(p, i) in players" :key="p.name" class="phone" :aria-label="p.name">
        <header>
          <strong>{{ p.name }}</strong>
          <span class="build">build {{ p.build }}</span>
          <span :class="['net', p.status]">{{ p.status }}</span>
        </header>
        <template v-if="!p.room">
          <div class="row">
            <button class="tw-btn" type="button" :disabled="!ready || p.busy" @click="api?.create(i)">Create a room</button>
            <button class="tw-btn" type="button" :disabled="!ready || p.busy" @click="api?.quick(i)">Quick play</button>
          </div>
          <div class="row">
            <input v-model="p.code" class="code" maxlength="12" :aria-label="`Room code for ${p.name}`" placeholder="CODE" />
            <button class="tw-btn" type="button" :disabled="!ready || p.busy || !p.code" @click="api?.join(i)">Join</button>
          </div>
        </template>
        <template v-else>
          <p class="room">
            Room <b class="roomcode">{{ p.room.code }}</b>, {{ p.room.visibility }}, {{ p.room.phase === 'playing' ? 'playing' : 'in the lobby' }}
            <span v-if="p.countdown !== null" class="count">starts in {{ p.countdown.toFixed(1) }} s</span>
          </p>
          <ul class="members">
            <li v-for="m in p.room.members" :key="m.seat" :class="{ me: m.seat === p.room.you }">
              <span class="seat">{{ m.seat }}</span>
              <span class="who">{{ m.name }}<template v-if="m.host"> (host)</template></span>
              <span :class="['tag', state(m).replace(' ', '-')]">{{ state(m) }}</span>
            </li>
          </ul>
          <div class="row">
            <button v-if="p.room.phase === 'lobby'" class="tw-btn" type="button" :disabled="p.busy" @click="api?.setReady(i)">{{ p.room.members.find(m => m.seat === p.room!.you)?.ready ? 'Not ready' : 'Ready' }}</button>
            <button class="tw-btn" type="button" :disabled="p.busy" @click="api?.leave(i)">Leave</button>
            <button class="tw-btn" type="button" @click="api?.drop(i)">Drop connection</button>
          </div>
        </template>
        <p v-if="p.error" class="err">{{ p.error }}</p>
      </section>
    </div>
    <div class="server">
      <strong>On the server</strong>
      <span v-if="!rooms.length" class="none">no rooms</span>
      <span v-for="r in rooms" :key="r.code" class="srv-room">
        <b>{{ r.code }}</b> {{ r.visibility }}, build {{ r.build }}, {{ r.phase }}, {{ r.seats }}/{{ r.max }} seats<template v-if="r.closesIn !== null">, empty: closes in {{ r.closesIn }} s</template>
      </span>
    </div>
  </figure>
</template>

<style scoped>
.lobby-top { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; padding: 14px 18px; border-bottom: 1px solid var(--tw-rule); }
.story { margin: 0; flex: 1 1 260px; font-size: 14.5px; color: var(--tw-ink-2); line-height: 1.45; }
.phones { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1px; background: var(--tw-rule); }
.phone { background: var(--tw-panel); padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.phone header { display: flex; align-items: baseline; gap: 8px; }
.phone header strong { font-family: var(--tw-font-display); font-size: 20px; letter-spacing: 0.02em; }
.build { font-size: 13px; color: var(--tw-ink-3); }
.net { margin-left: auto; font-size: 13px; color: var(--tw-ink-3); }
.net.online { color: var(--tw-ok); }
.row { display: flex; flex-wrap: wrap; gap: 6px; }
.code { font: inherit; font-size: 14px; width: 92px; padding: 6px 9px; border-radius: 7px; border: 1px solid var(--tw-rule); background: var(--tw-paper); color: var(--tw-ink); text-transform: uppercase; letter-spacing: 0.08em; }
.code:focus-visible { outline: 2px solid var(--tw-ws); outline-offset: 1px; }
.room { margin: 0; font-size: 14px; color: var(--tw-ink-2); line-height: 1.5; }
.roomcode { color: var(--tw-ink); letter-spacing: 0.08em; }
.count { display: block; color: var(--tw-ws); font-weight: 700; }
.members { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; font-size: 14px; }
.members li { display: flex; gap: 8px; align-items: center; padding: 3px 6px; border-radius: 5px; }
.members li.me { background: var(--tw-ws-soft); }
.seat { width: 18px; color: var(--tw-ink-3); font-variant-numeric: tabular-nums; }
.who { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { font-size: 12.5px; color: var(--tw-ink-3); }
.tag.ready { color: var(--tw-ok); font-weight: 700; }
.tag.reconnecting { color: var(--tw-loss); }
.err { margin: 0; font-size: 13px; color: var(--tw-loss); }
.server { display: flex; flex-wrap: wrap; gap: 4px 18px; padding: 12px 18px; border-top: 1px solid var(--tw-rule); background: var(--tw-paper-2); font-size: 13.5px; color: var(--tw-ink-2); }
.server strong { color: var(--tw-ink); }
.none { color: var(--tw-ink-3); }
.srv-room b { color: var(--tw-ink); letter-spacing: 0.06em; }
</style>
