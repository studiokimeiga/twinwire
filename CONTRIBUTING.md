# Contributing to Twinwire

Thanks for helping. Issues and pull requests are welcome: bugs with a reproduction, browsers or networks where
something misbehaves, documentation that misled you, and focused improvements.

## Setting up

Node 22 or newer.

```sh
npm install
npm run check                       # build + 89 unit and integration tests (a few seconds)
npm run test:native                 # needs node-datachannel (a dev dependency) and UDP on localhost
npx playwright install chromium firefox webkit
npm run test:browser                # real browsers against the native server; IMPAIR=1 and RTC=0 variants
npm run test:example                # the party example in three browsers
```

## What keeps it correct

- A session's identity survives transport changes. A data channel being "open" is not proof: only probe replies are.
- State is latest-wins; anything that must arrive is an event. Bound every queue, buffer and history.
- Browser entry points (`src/client`, `src/netcode`, `src/core`, `src/browser.ts`) never import Node or native code.
- A requested native RTC run must fail without node-datachannel rather than pass on the WebSocket fallback.
- Games own physics, collision, authority and persistence; Twinwire doesn't decide what's legal.
- Any change to the bytes on the wire bumps `VERSION` in `src/core/protocol.ts`.

## Pull requests

- Add a regression test for any lifecycle or protocol fix; the test should fail without your change.
- Keep the code style of the file you're in; explain *why* in comments where it isn't obvious.
- Run `npm run check` (CI also runs the native and browser gates).
- Update `docs/` and `CHANGELOG.md` when behaviour or API changes.

By contributing you agree your work is released under the MIT license.
