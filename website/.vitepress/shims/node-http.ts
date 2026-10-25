// GameServer only asks node:http for a server to hang its WebSocket server on. In the page there is no port: the
// explainers hand connections to the (simulated) WebSocket server directly.
export function createServer() {
  return {
    listen(_port: number, _host: string, ready: () => void) { setTimeout(ready, 0); },
    once() {}, off() {},
    address() { return { port: 0 }; },
    close(done?: () => void) { done?.(); },
  };
}
export default { createServer };
