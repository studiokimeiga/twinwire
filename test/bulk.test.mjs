import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import * as clientApi from '../dist/client/index.js';
import * as serverApi from '../dist/server/index.js';
import { sleep, until } from './helpers.mjs';

async function fixture(t, options = {}) {
  assert.equal(typeof serverApi.createBulkHandler, 'function');
  assert.equal(typeof clientApi.BulkClient, 'function');
  const handler = serverApi.createBulkHandler({ origins: ['https://game.test'], ...options });
  const server = createServer((req, res) => { void handler(req, res).then(handled => {
    if (!handled) { res.writeHead(404); res.end(); }
  }).catch(()=>{res.writeHead(500);res.end();}); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { handler, base: `http://127.0.0.1:${server.address().port}/resources/` };
}

test('HTTP bulk bytes are independently fetched with a verified content hash', async t => {
  const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
  const { base } = await fixture(t, { resolve: async id => id === 'region1' ? { bytes } : null });
  const client = new clientApi.BulkClient({ maxBytes: 200_000 }); t.after(() => client.close());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const received = await client.request(base + 'region1', { sha256 }).promise;
  assert.deepEqual(received, bytes);
  assert.equal(client.active, 0, 'a fulfilled request has released its concurrency reservation');
  await assert.rejects(client.request(base + 'region1', { sha256: '0'.repeat(64) }).promise, /integrity/i);
  assert.equal(client.active, 0);
});

test('a fulfilled request can immediately use the same slot when queueing is disabled', async t => {
  const { base } = await fixture(t, { resolve: async () => ({ bytes: new Uint8Array([1]) }) });
  const client = new clientApi.BulkClient({ concurrency: 1, maxQueued: 0, maxBytes: 10 });
  t.after(() => client.close());
  await client.request(base + 'one').promise;
  await client.request(base + 'two').promise;
  assert.equal(client.active, 0);
});

test('bulk concurrency, queue admission and cancellation stay bounded', async t => {
  let inflight = 0, peak = 0, started = 0;
  const { base } = await fixture(t, { maxConcurrent: 4, resolve: async (_id, signal) => {
    inflight++; started++; peak = Math.max(peak, inflight);
    try { await sleep(80); signal.throwIfAborted(); return { bytes: new Uint8Array([1]) }; }
    finally { inflight--; }
  } });
  const client = new clientApi.BulkClient({ concurrency: 2, maxQueued: 1, maxBytes: 100 });
  t.after(() => client.close());
  const a = client.request(base + 'a'), b = client.request(base + 'b'), c = client.request(base + 'c');
  assert.throws(() => client.request(base + 'full'), /queue/i);
  const cancelled = assert.rejects(c.promise, { name: 'AbortError' }); c.cancel(); await cancelled;
  await Promise.all([a.promise, b.promise]);
  assert.equal(started, 2); assert.equal(peak, 2); assert.equal(client.queued, 0);
  const d = client.request(base + 'd');
  const aborted = assert.rejects(d.promise, { name: 'AbortError' });
  await until(() => client.active === 1); client.close(); await aborted;
  await until(() => client.active === 0);
  assert.throws(() => client.request(base + 'closed'), /closed/i);
});

test('declared and streamed resource size limits are enforced before unbounded allocation', async t => {
  const { base } = await fixture(t, { maxBytes: 50, resolve: async () => ({ bytes: new Uint8Array(100) }) });
  const response = await fetch(base + 'large');
  assert.equal(response.status, 413);
  const server = createServer((_req, res) => { res.writeHead(200); res.write(new Uint8Array(60)); res.end(new Uint8Array(60)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const client = new clientApi.BulkClient({ maxBytes: 100 }); t.after(() => client.close());
  await assert.rejects(client.request(`http://127.0.0.1:${server.address().port}/`).promise, /limit/i);
  assert.equal(client.active, 0);
});

test('bulk host validates origins, authorization, method, route and immutable versions', async t => {
  const { base } = await fixture(t, { authorize: req => req.headers.authorization === 'Bearer test-only',
    resolve: async () => ({ bytes: new Uint8Array([1, 2, 3]) }) });
  assert.equal((await fetch(base + 'one')).status, 403);
  assert.equal((await fetch(base + 'one', { headers: { authorization: 'Bearer test-only', origin: 'https://evil.test' } })).status, 403);
  const headers = { authorization: 'Bearer test-only', origin: 'https://game.test' };
  const first = await fetch(base + 'one', { headers });
  assert.equal(first.status, 200); assert.equal(first.headers.get('access-control-allow-origin'), 'https://game.test');
  const tag = first.headers.get('etag'); assert.ok(tag); await first.arrayBuffer();
  assert.equal((await fetch(base + 'one', { headers: { ...headers, 'if-none-match': tag } })).status, 304);
  assert.equal((await fetch(base + 'one', { method: 'POST', headers })).status, 405);
  assert.equal((await fetch(base + 'bad%2Fid', { headers })).status, 400);
});

test('HTTP bulk works on a browser without AbortSignal.throwIfAborted', async t => {
  const {base}=await fixture(t,{resolve:async()=>({bytes:new Uint8Array([3])})});
  const client=new clientApi.BulkClient({maxBytes:10});t.after(()=>client.close());
  const original=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'throwIfAborted');
  Object.defineProperty(AbortSignal.prototype,'throwIfAborted',{value:undefined,configurable:true,writable:true});
  try{assert.deepEqual(await client.request(base+'legacy').promise,new Uint8Array([3]));}
  finally{Object.defineProperty(AbortSignal.prototype,'throwIfAborted',original);}
});

test('a stalled HTTP response times out and releases its admission slot',async t=>{
  const server=createServer((_req,res)=>{res.writeHead(200);res.flushHeaders();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const client=new clientApi.BulkClient({concurrency:1,maxQueued:0,maxBytes:100,timeoutMs:30});t.after(()=>client.close());
  await Promise.race([assert.rejects(client.request(`http://127.0.0.1:${server.address().port}/`).promise,{name:'TimeoutError'}),
    sleep(300).then(()=>{throw Error('stalled transfer did not time out');})]);
  assert.equal(client.active,0);
});

test('a malformed network-path request target returns 400 rather than rejecting the handler',async t=>{
  const {base}=await fixture(t,{resolve:async()=>({bytes:new Uint8Array([1])})});
  const url=new URL(base);
  const status=await new Promise((resolve,reject)=>{const request=httpRequest({host:url.hostname,port:url.port,path:'//[',method:'GET'},response=>{
    response.resume();resolve(response.statusCode);
  });request.on('error',reject);request.end();});
  assert.equal(status,400);
});

test('resource bytes remain the hashed snapshot if the game reuses its source buffer during delivery',async t=>{
  const bytes=Buffer.alloc(8*1024*1024,7),hash=createHash('sha256').update(bytes).digest('hex');
  const {base}=await fixture(t,{maxBytes:bytes.length,resolve:async()=>({bytes})});
  const client=new clientApi.BulkClient({maxBytes:bytes.length,fetch:async(...args)=>{const response=await fetch(...args);bytes.fill(9);return response;}});
  t.after(()=>client.close());
  const result=await client.request(base+'snapshot',{sha256:hash}).promise;
  assert.equal(result.length,8*1024*1024);assert.ok(result.every(byte=>byte===7));
});
