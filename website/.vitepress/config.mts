import { defineConfig } from 'vitepress';
import { fileURLToPath } from 'node:url';

// The explainers run the library itself: the built files in ../dist (the same ones npm ships), through the package's
// own entry points. Build it first: `npm run build` at the repository root.
const dist = (p: string) => fileURLToPath(new URL(`../../dist/${p}`, import.meta.url));
const shim = (p: string) => fileURLToPath(new URL(`./shims/${p}`, import.meta.url));
const base = '/twinwire/';

export default defineConfig({
  base,
  lang: 'en',
  title: 'Twinwire',
  description: 'Multiplayer networking for browser games: one resumable session on two wires (WebSocket and WebRTC datagrams), a lobby, and the netcode an authoritative server needs.',
  cleanUrls: true,
  appearance: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Mono:wght@400;600&family=Atkinson+Hyperlegible+Next:ital,wght@0,400;0,600;0,700;1,400&family=Big+Shoulders+Display:wght@600;700;800&display=swap' }],
    ['meta', { name: 'theme-color', content: '#17192e' }],
    ['meta', { property: 'og:title', content: 'Twinwire: multiplayer networking for browser games' }],
    ['meta', { property: 'og:description', content: 'One session, two wires: WebSocket for what must arrive, WebRTC datagrams for what must arrive fast. Every browser, iPhone Safari included.' }],
  ],
  themeConfig: {
    logo: { src: '/logo.svg', alt: '' },
    siteTitle: 'Twinwire',
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'How it works', link: '/how/sessions', activeMatch: '/how/' },
      { text: 'Reference', link: '/reference/api/', activeMatch: '/reference/' },
      { text: '1.0.0', items: [
        { text: 'Changelog', link: '/reference/changelog' },
        { text: 'npm', link: 'https://www.npmjs.com/package/twinwire' },
      ] },
    ],
    sidebar: {
      '/guide/': sidebar(),
      '/how/': sidebar(),
      '/reference/': sidebar(),
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/studiokimeiga/twinwire' }],
    search: { provider: 'local' },
    outline: { level: [2, 3], label: 'On this page' },
    editLink: { pattern: 'https://github.com/studiokimeiga/twinwire/edit/main/website/:path', text: 'Edit this page on GitHub' },
    docFooter: { prev: 'Previous', next: 'Next' },
    footer: {
      message: 'MIT licensed. Source on <a href="https://github.com/studiokimeiga/twinwire">GitHub</a>, package on <a href="https://www.npmjs.com/package/twinwire">npm</a>.',
      copyright: 'Made by Studio Kimeiga.',
    },
  },
  markdown: {
    theme: { light: 'min-light', dark: 'tokyo-night' },
  },
  vite: {
    resolve: {
      alias: [
        { find: /^twinwire\/browser$/, replacement: dist('browser/twinwire.mjs') },
        { find: /^twinwire\/(client|server|netcode)$/, replacement: dist('$1/index.js') },
        { find: /^twinwire$/, replacement: dist('index.js') },
        { find: /^node:crypto$/, replacement: shim('node-crypto.ts') },
        { find: /^node:http$/, replacement: shim('node-http.ts') },
      ],
    },
    server: { fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
    build: { chunkSizeWarningLimit: 900 },
  },
});

function sidebar() {
  return [
    { text: 'Guide', items: [
      { text: 'Getting started', link: '/guide/getting-started' },
      { text: 'The party example', link: '/guide/party' },
    ] },
    { text: 'How it works', items: [
      { text: 'Sessions that survive', link: '/how/sessions' },
      { text: 'Two wires', link: '/how/two-wires' },
      { text: 'Snapshot interpolation', link: '/how/interpolation' },
      { text: 'Prediction and reconciliation', link: '/how/prediction' },
      { text: 'Delta snapshots', link: '/how/deltas' },
      { text: 'Interest management', link: '/how/interest' },
      { text: 'The lobby', link: '/how/lobby' },
    ] },
    { text: 'Reference', items: [
      { text: 'Entry points', link: '/reference/api/' },
      { text: 'twinwire/client', link: '/reference/api/client' },
      { text: 'twinwire/server', link: '/reference/api/server' },
      { text: 'twinwire/netcode', link: '/reference/api/netcode' },
      { text: 'twinwire/browser', link: '/reference/api/browser' },
      { text: 'Operations', link: '/reference/operations' },
      { text: 'Adopting it', link: '/reference/adopting' },
      { text: 'Changelog', link: '/reference/changelog' },
    ] },
  ];
}
