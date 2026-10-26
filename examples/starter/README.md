# Twinwire starter

Node 22 or newer. This folder is a standalone game: it installs the published Twinwire package, without a build tool.

~~~sh
npm install
npm start
~~~

Open http://127.0.0.1:8787 in two tabs. Move with WASD, arrows or a drag. Send a reliable ping to add a point. Disconnect for two seconds: the same ID, position and score return after fresh state arrives. Reloading the same tab also resumes from its sessionStorage checkpoint. Closing the tab eventually expires its player after 30 seconds. Use the New session button only if recovery expires.

WebSocket works without a native module. To test datagrams, install the optional node-datachannel dependency and run RTC=1 npm start (PowerShell: $env:RTC='1'; npm start). A requested RTC start fails if the module cannot load. Add ?rtc=0 to a browser URL for a WebSocket-only control.

server.mjs validates and applies movement at 60 Hz, sends self-contained snapshots at 20 Hz, and removes expired sessions. game.mjs passes snapshots through receiveState before playback. Reliable pings and replaceable input are different streams. The example has no authentication or persistence: add game-owned authority checks, accounts and saved worlds before extending it into a production service.

Production: HOST=0.0.0.0, PORT=8787, ORIGINS=https://your-game.example. Put HTTPS/WSS in front of TCP 8787 and, if RTC is enabled, open UDP 8788. Deploy both client and server from one SDK version. See the website Operations guide for limits and TURN.
