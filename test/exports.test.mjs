import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

// what a project that installed the package sees: every entry point resolves through package.json "exports"
test('every published entry point resolves by package name', async () => {
  const core = await import('twinwire'), client = await import('twinwire/client'), server = await import('twinwire/server'), netcode = await import('twinwire/netcode');
  assert.equal(typeof core.Endpoint, 'function'); assert.equal(core.VERSION, 4);
  for (const k of ['GameClient', 'LobbyClient', 'StateReceiver']) assert.equal(typeof client[k], 'function', k);
  for (const k of ['createGameServer', 'GameServer', 'Lobby', 'createNativeRtcFactory', 'turnCredentials', 'cloudflareTurn']) assert.equal(typeof server[k], 'function', k);
  for (const k of ['NetworkClock', 'Timeline', 'AdaptivePlayback', 'Predictor', 'InputInbox', 'FixedStepper', 'SnapshotHistory', 'diffEntities', 'applyEntityDelta', 'ReplicaSender', 'SpatialGrid', 'defineSchema']) assert.equal(typeof netcode[k], 'function', k);
  const require = createRequire(import.meta.url);
  const iife = require.resolve('twinwire/browser'), esm = await import('twinwire/browser');
  assert.match(iife, /dist[\\/]browser[\\/]twinwire\.js$/);
  assert.match(await readFile(iife, 'utf8'), /var Twinwire\s*=/);
  assert.equal(typeof esm.GameClient, 'function'); assert.equal(typeof esm.LobbyClient, 'function');
  assert.equal(typeof esm.StateReceiver, 'function');
});

test('browser entry points carry no Node or native imports', async () => {
  for (const f of ['dist/browser/twinwire.js', 'dist/browser/twinwire.mjs']) {
    const s = await readFile(new URL('../' + f, import.meta.url), 'utf8');
    assert.doesNotMatch(s, /\b(require\(|from\s*["']node:|import\(["']node-datachannel|import\(["']ws["'])/, f);
  }
});

test('Worker entry shares GameSession with Node and bundles without Node/native modules',async()=>{
 const worker=await import('twinwire/worker'),server=await import('twinwire/server');
 assert.equal(worker.GameSession,server.GameSession);
 assert.equal(typeof worker.SocketSessionServer,'function');
 const {build}=await import('esbuild');
 const bundle=await build({entryPoints:[new URL('../dist/worker.js',import.meta.url).pathname],bundle:true,platform:'browser',write:false,metafile:true});
 assert.ok(bundle.outputFiles[0].text.includes('SocketSessionServer'));
 for(const input of Object.keys(bundle.metafile.inputs))assert.doesNotMatch(input,/node_modules|node:/);
});
