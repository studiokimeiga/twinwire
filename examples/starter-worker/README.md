# Hosted starter

The same two-tab arena as ../starter, hosted in a Cloudflare Durable Object with twinwire/worker. It uses WebSocket only. The Node starter can also use native RTC. Each invite URL selects its own eight-player arena.

Run npm install, then npm run dev (localhost:8789). Open the same invite in two tabs; move, ping and disconnect. npm run deploy publishes the paired client and Worker. For your own domain, set the exact allowed origin in worker.mjs and the Worker name in wrangler.toml. Keep the invite's room query when sharing.

Transport and demo world are in memory. A short socket interruption keeps the same ID, score and coordinates. A server restart/eviction loses this example's arena; the UI offers a new session. For a persistent game, store the world and private seat authorization separately. This example deliberately does not claim hibernation restoration or durable transport replay.
