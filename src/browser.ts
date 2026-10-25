/** Everything a browser page needs, for a script tag or a single-file build: window.Twinwire. */
export * from './client/index.js';
export * from './netcode/index.js';
export { LOBBY_KEY, normalizeCode, cleanName } from './core/lobby.js';
export { VERSION, MTU_STATE_BYTES, DEFAULT_STATE_BYTES } from './core/protocol.js';
