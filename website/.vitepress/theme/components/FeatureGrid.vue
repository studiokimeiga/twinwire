<script setup lang="ts">
import { withBase } from 'vitepress';
// The rule above each feature is the colour of the wire it lives on: cobalt for the WebSocket (the session, events),
// amber for the datagram path (state), ink for what sits above both.
const features = [
  { wire: 'dg', title: 'Two wires, one session', text: 'State rides WebRTC datagrams while probes prove the path works both ways, and moves to the WebSocket within about 1.5 s when it stops. One UDP port on the server for every player.', link: '/how/two-wires' },
  { wire: 'ws', title: 'Sessions that survive', text: 'A dropped connection resumes the same session: same identity, same lobby seat, unacknowledged events replayed both ways. A reload with a checkpoint keeps the seat too.', link: '/how/sessions' },
  { wire: 'ws', title: 'Events at UDP speed', text: 'Ordered, acknowledged JSON events go on the WebSocket and race a copy on the datagrams. Whichever lands first is delivered, once, in order.', link: '/how/two-wires' },
  { wire: 'dg', title: 'State, latest wins', text: 'Binary streams that coalesce and expire instead of queueing, up to 64 KiB, with acknowledgements so you can send deltas against what each player has.', link: '/how/deltas' },
  { wire: 'ink', title: 'A lobby', text: 'Private rooms with codes, quick play matched by mode and build, stable seats, host hand-off, ready-up with a countdown, kick, rate limits.', link: '/how/lobby' },
  { wire: 'ink', title: 'Netcode helpers', text: 'Clock sync, snapshot interpolation with adaptive delay, prediction and reconciliation, input redundancy, fixed steps, interest queries, binary codecs.', link: '/how/interpolation' },
  { wire: 'dg', title: 'STUN and TURN', text: 'ICE servers handed to each client by your server, so you can rotate them without a new build: coturn credentials or Cloudflare’s managed relay.', link: '/reference/operations' },
  { wire: 'ink', title: 'Browser first', text: 'Tested in Chromium, Firefox and WebKit against the real server, on a bad network and with UDP blocked. See the measured support and release checks.', link: '/reference/verification' },
];
</script>

<template>
  <div class="features">
    <a v-for="f in features" :key="f.title" :class="['feature', f.wire]" :href="withBase(f.link)">
      <h3>{{ f.title }}</h3>
      <p>{{ f.text }}</p>
    </a>
  </div>
</template>

<style scoped>
.features { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 30px 28px; margin: 24px 0 8px; }
.feature { display: block; padding-top: 14px; border-top: 3px solid var(--tw-ink); text-decoration: none; color: inherit; }
.feature.ws { border-top-color: var(--tw-ws); }
.feature.dg { border-top-color: var(--tw-dg-fill); }
.feature h3 { font-family: var(--tw-font-display); font-size: 23px; font-weight: 700; margin: 0 0 6px; color: var(--tw-ink); letter-spacing: 0.01em; border: 0; padding: 0; line-height: 1.15; }
.feature p { margin: 0; font-size: 15px; line-height: 1.6; color: var(--tw-ink-2); }
.feature:hover h3 { color: var(--tw-ws); }
.feature:focus-visible { outline: 2px solid var(--tw-ws); outline-offset: 4px; }
</style>
