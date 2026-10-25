# Working on Twinwire

Networking for browser games (authoritative server, WebSocket + WebRTC datagrams, lobby, netcode helpers), open
source under MIT. Read README.md, docs/ARCHITECTURE.md and validation/STATUS.md first.

Rules that keep it correct:
- Preserve session identity across transport changes. A channel being open isn't proof: only probe replies are.
- State is latest-wins; anything that must arrive is an event. Bound every queue, buffer and history.
- Browser entries (`src/client`, `src/netcode`, `src/core`, `src/browser.ts`) never import Node or native modules.
- A requested native RTC run must fail without node-datachannel, never pass on the WebSocket fallback.
- Physics, collision, authority and persistence belong to the games.
- Bump `VERSION` in `src/core/protocol.ts` for any wire change; games deploy client and server together.

Before committing: `npm run check`. Before a release: also `npm run test:native`, `npm run test:browser` (plain,
`IMPAIR=1`, `RTC=0`) and `npm run test:example` (plain and `RTC=1`), then update validation/STATUS.md with what
actually ran, and CHANGELOG.md. Releases publish from a `v*` tag (.github/workflows/release.yml). Add a regression test for every
lifecycle or protocol bug. Never commit tokens, TURN secrets or node_modules.
