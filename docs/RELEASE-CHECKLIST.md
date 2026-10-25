# Release checklist

For maintainers, before tagging `vX.Y.Z` (the tag publishes to npm: `.github/workflows/release.yml`).

- [ ] `npm ci && npm run check` (build, all tests, 0 skipped).
- [ ] `npm run test:native`: datagrams selected, fallback and recovery in the same session.
- [ ] `npm run test:browser`, `IMPAIR=1 npm run test:browser`, `RTC=0 npm run test:browser`: Chromium, Firefox, WebKit.
- [ ] `npm run test:example` and `RTC=1 npm run test:example`.
- [ ] `npm audit` clean; `npm pack --dry-run` lists only `dist`, docs, README, LICENSE, CHANGELOG.
- [ ] Wire change? `VERSION` bumped in `src/core/protocol.ts`, and the change called out in CHANGELOG.md.
- [ ] `validation/STATUS.md` updated with what actually ran; `CHANGELOG.md` has the version's entry.
- [ ] `version` in package.json matches the tag.

# Before you ship a game on it

Things a library's tests can't establish for your game:

- Safari on the oldest iOS you support and the newest, on a real phone: Wi-Fi and cellular, the hand-off between them,
  screen lock, backgrounding, reload and page restore.
- Your server corrects invalid movement and judges hits by its own rules; nothing private leaks through snapshots,
  interest filtering, broadcasts or reconnects.
- Actions that must happen exactly once (purchases, transfers) carry an action id and are stored with their result.
- Your simulation, serialization and traffic stay inside their frame budget at the player counts you expect, on the
  machine you'll run (`tools/bench.mjs` for the transport; your own world for the rest).
- Your monthly transfer fits your host's allowance (`npm run budget`).
