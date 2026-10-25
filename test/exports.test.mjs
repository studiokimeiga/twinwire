import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

// what a project that installed the package sees: every entry point resolves through package.json "exports"
test('every published entry point resolves by package name', async () => {
  const core = await import('twinwire'), client = await import('twinwire/client'), server = await import('twinwire/server'), netcode = await import('twinwire/netcode');
  assert.equal(typeof core.Endpoint, 'function'); assert.equal(core.VERSION, 3);
  for (const k of ['GameClient', 'LobbyClient']) assert.equal(typeof client[k], 'function', k);
  for (const k of ['createGameServer', 'GameServer', 'Lobby', 'createNativeRtcFactory', 'turnCredentials', 'cloudflareTurn']) assert.equal(typeof server[k], 'function', k);
  for (const k of ['NetworkClock', 'Timeline', 'AdaptivePlayback', 'Predictor', 'InputInbox', 'FixedStepper', 'SnapshotHistory', 'diffEntities', 'applyEntityDelta', 'ReplicaSender', 'SpatialGrid', 'defineSchema']) assert.equal(typeof netcode[k], 'function', k);
  const require = createRequire(import.meta.url);
  const iife = require.resolve('twinwire/browser'), esm = await import('twinwire/browser');
  assert.match(iife, /dist[\\/]browser[\\/]twinwire\.js$/);
  assert.match(await readFile(iife, 'utf8'), /var Twinwire\s*=/);
  assert.equal(typeof esm.GameClient, 'function'); assert.equal(typeof esm.LobbyClient, 'function');
});

test('browser entry points carry no Node or native imports', async () => {
  for (const f of ['dist/browser/twinwire.js', 'dist/browser/twinwire.mjs']) {
    const s = await readFile(new URL('../' + f, import.meta.url), 'utf8');
    assert.doesNotMatch(s, /\b(require\(|from\s*["']node:|import\(["']node-datachannel|import\(["']ws["'])/, f);
  }
});
