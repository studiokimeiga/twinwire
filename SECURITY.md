# Security

Please report vulnerabilities privately, through GitHub's **Report a vulnerability** (the repository's Security tab),
not in a public issue. Include what an attacker can do, how to reproduce it, and the version. You'll get an answer
within a few days, and a fix or a plan as soon as one is ready.

What's in scope: the server's handling of untrusted connections (handshakes, frames, events, signalling, lobby
requests), resource limits, session and resume-token handling, and anything in the browser client that a malicious
server or peer could abuse.

Things to know when deploying:

- Serve over HTTPS/WSS and list exact `origins` (an origin check isn't authentication; use `authenticate` for accounts).
- Resume tokens and `checkpoint()` contents are bearer secrets: never log them or put them in URLs.
- Behind a reverse proxy, set `trustProxy` so per-address limits see real addresses (and limit at the proxy too).
- `allowImpairment` is for development only.
- Validate every event and state in your game: Twinwire carries them, it doesn't judge them.
