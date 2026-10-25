<script setup lang="ts">
import { withBase } from 'vitepress';
import { ref } from 'vue';
import WiresDemo from './demos/WiresDemo.vue';
const copied = ref(false);
const copy = async () => { try { await navigator.clipboard.writeText('npm install twinwire'); copied.value = true; setTimeout(() => copied.value = false, 1600); } catch { /* no clipboard */ } };
</script>

<template>
  <section class="hero">
    <div class="text">
      <h1>One session,<br />two wires.</h1>
      <p class="lede">
        Multiplayer networking for browser games. A <span class="ws">WebSocket</span> for what must arrive,
        <span class="dg">WebRTC datagrams</span> for what must arrive fast, and a player session that survives dropped
        connections, app switches and Wi-Fi hand-offs. Every browser, iPhone Safari included.
      </p>
      <div class="cta">
        <button class="install" type="button" :aria-label="copied ? 'Copied' : 'Copy the install command'" @click="copy">
          <code>npm install twinwire</code><span class="hint">{{ copied ? 'Copied' : 'Copy' }}</span>
        </button>
        <div class="links">
          <a class="go primary" :href="withBase('/guide/getting-started')">Get started</a>
          <a class="go" :href="withBase('/how/sessions')">How it works</a>
        </div>
      </div>
    </div>
    <div class="live">
      <WiresDemo variant="hero" />
      <p class="note">
        This is Twinwire running in your browser: a browser's endpoint and a server's, exchanging real frames over a
        simulated network, slowed down so you can watch. Block UDP, and within 1.5 seconds of game time everything is on
        the WebSocket, without the session noticing.
      </p>
    </div>
  </section>
</template>

<style scoped>
.hero { max-width: 1152px; margin: 0 auto; padding: 56px 24px 24px; display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); gap: 40px; align-items: center; }
h1 { font-family: var(--tw-font-display); font-weight: 800; font-size: clamp(54px, 7.4vw, 96px); line-height: 0.92; letter-spacing: 0.005em; margin: 0 0 22px; color: var(--tw-ink); }
.lede { font-size: 19px; line-height: 1.6; color: var(--tw-ink-2); margin: 0 0 26px; max-width: 34em; }
.cta { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
.links { display: flex; flex-wrap: wrap; gap: 10px; }
.install { display: inline-flex; align-items: center; gap: 12px; padding: 9px 12px 9px 14px; border-radius: 8px; border: 1px solid var(--tw-rule); background: var(--tw-panel); color: var(--tw-ink); cursor: pointer; font: inherit; }
.install code { font-family: var(--tw-font-mono); font-size: 15px; font-weight: 600; background: none; padding: 0; color: var(--tw-ink); }
.install .hint { font-size: 13px; color: var(--tw-ink-3); }
.install:hover { border-color: var(--tw-ws); }
.go { display: inline-block; padding: 10px 16px; border-radius: 8px; font-weight: 700; font-size: 15px; border: 1px solid var(--tw-rule); color: var(--tw-ink); text-decoration: none; background: var(--tw-panel); }
.go:hover { border-color: var(--tw-ws); color: var(--tw-ws); }
.go.primary { background: var(--tw-ws); border-color: var(--tw-ws); color: var(--tw-panel); }
.go.primary:hover { background: var(--tw-ws-strong); color: var(--tw-panel); }
.install:focus-visible, .go:focus-visible { outline: 2px solid var(--tw-ws); outline-offset: 2px; }
.note { font-size: 13.5px; line-height: 1.55; color: var(--tw-ink-3); margin: 10px 2px 0; }
@media (max-width: 900px) {
  .hero { grid-template-columns: 1fr; padding-top: 36px; gap: 28px; }
}
@media (max-width: 640px) {
  .hero { padding: 28px 16px 8px; }
  .lede { font-size: 17px; }
}
</style>
