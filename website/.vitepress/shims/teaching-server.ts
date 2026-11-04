// Use the real session/lobby implementation with LiveNet's simulated sockets. These lessons do not run the
// Node-only resource HTTP handler, TURN signer or native transport factory inside a browser.
export { GameServer, type GameServerOptions } from '../../../dist/server/server.js';
export { Lobby } from '../../../dist/server/lobby.js';
