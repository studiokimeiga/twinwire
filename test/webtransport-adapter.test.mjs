import test from 'node:test';
import assert from 'node:assert/strict';
import * as clientApi from '../dist/client/index.js';
import * as serverApi from '../dist/server/index.js';
import { until, sleep } from './helpers.mjs';
import { WebSocket } from 'ws';
import { writeBinding, readBinding } from '../dist/core/webtransport.js';
import { VERSION } from '../dist/core/protocol.js';

function memorySessions() {
  const ab = new TransformStream(), ba = new TransformStream();
  let offered;
  const incoming = new ReadableStream({ start(controller) { offered = controller; } });
  const datagramsAB = new TransformStream(), datagramsBA = new TransformStream();
  let endA, endB;
  const a = { ready: Promise.resolve(), reliability: 'supports-unreliable',
    closed: new Promise(resolve => { endA = resolve; }),
    datagrams: { readable: datagramsBA.readable, writable: datagramsAB.writable, maxDatagramSize: 1200 },
    async createBidirectionalStream() { offered.enqueue({ readable: ab.readable, writable: ba.writable });
      return { readable: ba.readable, writable: ab.writable }; }, close() { endA(); endB(); } };
  const b = { closed: new Promise(resolve => { endB = resolve; }),
    incomingBidirectionalStreams: incoming,
    datagrams: { readable: datagramsAB.readable, writable: datagramsBA.writable, maxDatagramSize: 1200 },
    close: a.close };
  return { a,b };
}

test('WebTransport adapter frames and authenticates the fast path against the live WebSocket epoch', async t => {
  assert.equal(typeof serverApi.acceptWebTransport, 'function');
  let claim; const offers = [];
  const host = { url: 'https://game.test/twinwire', setAcceptor(fn) { claim = fn; }, async close() {} };
  const server = await serverApi.createGameServer({ origins: [], allowMissingOrigin: true, webtransport: host, pumpHz: 10 });
  const client = new clientApi.GameClient({ url: `ws://127.0.0.1:${await server.listen()}/connect`, room: 'wt', rtc: false,
    websocket: u => new WebSocket(u), syncPingMs: 10, endpoint: { probeIntervalMs: 20, probeTimeoutMs: 100 },
    webtransport: { create() {
      const pair = memorySessions();
      offers.push(serverApi.acceptWebTransport(pair.b, claim, { origin: undefined, unreliableDatagrams: true })); return pair.a;
    } } });
  t.after(async () => { client.close(); await server.close(); await Promise.all(offers); });
  const events = []; client.onEvent = d => events.push(d);
  client.connect(); await until(() => client.transport === 'wt', 3000);
  const id = client.id, session = server.sessions.get(id);
  // Each endpoint needs its own probe replies. Client proof can precede the slower server pump.
  await until(() => session.endpoint.datagramProven('wt'));
  session.onEvent = d => session.sendEvent(d);
  client.sendEvent({ once: 1 }); await until(() => events.length === 1);
  const states = []; client.onState = s => states.push(s);
  session.sendState(1, new Uint8Array(100)); session.flush(); await until(() => states.length === 1);
  assert.equal(states[0].via, 'wt');
  session.sendState(2, new Uint8Array(3000)); session.flush(); await until(() => states.length === 2);
  assert.equal(states[1].via, 'ws');
  client.simulateDrop(); await until(() => client.status !== 'online'); await until(() => client.transport === 'wt');
  assert.equal(client.id, id); assert.equal(server.sessions.size, 1);
  client.sendEvent({ once: 2 }); await until(() => events.length === 2);
  assert.deepEqual(events, [{ once: 1 }, { once: 2 }]);
});

test('binding parser rejects trailing bytes in a separate stream write', async () => {
  const bytes = new TextEncoder().encode('{"ok":true}'), frame = new Uint8Array(bytes.length + 4);
  new DataView(frame.buffer).setUint32(0, bytes.length); frame.set(bytes, 4);
  const readable = new ReadableStream({ start(controller) { controller.enqueue(frame); controller.enqueue(new Uint8Array([1])); controller.close(); } });
  await assert.rejects(readBinding(readable), /trailing/i);
});

test('client peer and endpoint teardown close each physical WebTransport session at most once', async t => {
  let claim;const pending=[],pairs=[];
  const host={url:'https://game.test/twinwire',setAcceptor(fn){claim=fn;},async close(){}};
  const server=await serverApi.createGameServer({origins:[],allowMissingOrigin:true,webtransport:host});
  const client=new clientApi.GameClient({url:`ws://127.0.0.1:${await server.listen()}/connect`,room:'wt-close',rtc:false,
    websocket:u=>new WebSocket(u),endpoint:{probeIntervalMs:20},webtransport:{create(){
      const pair=memorySessions(),counts={a:0,b:0};
      for(const side of ['a','b']){const close=pair[side].close;pair[side].close=()=>{counts[side]++;close();};}
      pairs.push(counts);pending.push(serverApi.acceptWebTransport(pair.b,claim,{unreliableDatagrams:true}));return pair.a;
    }}});
  t.after(async()=>{client.close();await server.close();await Promise.all(pending);});
  client.connect();await until(()=>client.transport==='wt');
  client.close();await until(()=>server.sessions.size===0);await sleep(10);
  assert.equal(pairs.length,1);assert.equal(pairs[0].a,1,'browser peer and endpoint share one physical close');
  assert.ok(pairs[0].b<=1,'remote close notification never closes the native session twice');
});

test('a timed-out binding cannot later claim a session when its delayed stream finally supplies bytes', async () => {
  const pair = memorySessions(); let claims = 0;
  const stream = await pair.a.createBidirectionalStream();
  await serverApi.acceptWebTransport(pair.b, () => { claims++; return null; }, { handshakeTimeoutMs: 15, unreliableDatagrams: true });
  try { await writeBinding(stream.writable, { v: VERSION, e: 1, a: 1, ticket: 't'.repeat(40), maxDatagramSize: 1200 }); } catch {}
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(claims, 0);
});

test('binding tickets are one-use, origin checked and fenced by the current connection epoch', async t => {
  let claim; const offers = [];
  const host = { url: 'https://game.test/twinwire', setAcceptor(fn) { claim = fn; }, async close() {} };
  const server = await serverApi.createGameServer({ origins: ['https://game.test'], webtransport: host });
  const client = new clientApi.GameClient({ url: `ws://127.0.0.1:${await server.listen()}/connect`, room: 'wt', rtc: false, webtransport: false,
    websocket: u => {
      const ws = new WebSocket(u, { origin: 'https://game.test' });
      ws.addEventListener('message', event => {
        if (typeof event.data === 'string') { const data = JSON.parse(event.data); if (data.t === 'welcome') offers.push(data); }
      }); return ws;
    } });
  t.after(async () => { client.close(); await server.close(); });
  client.connect(); await until(() => client.status === 'online' && offers.length === 1);
  const offered = offers[0];
  const request = { ticket: offered.wt.ticket, attempt: offered.wt.a, epoch: offered.e, origin: 'https://game.test' };
  assert.equal(claim({ ...request, origin: 'https://evil.test' }), null);
  assert.equal(claim({ ...request, epoch: offered.e + 1 }), null);
  assert.ok(claim(request)); assert.equal(claim(request), null, 'single-use proof');
  client.simulateDrop(); await until(() => offers.length === 2 && client.status === 'online');
  assert.equal(claim(request), null, 'old physical connection cannot bind');
  const fresh = offers[1];
  assert.notEqual(fresh.wt.ticket, request.ticket);
  client.close(); await until(() => server.sessions.size === 0);
  assert.equal(claim({ ticket: fresh.wt.ticket, attempt: fresh.wt.a, epoch: fresh.e, origin: 'https://game.test' }), null);
});

test('reliable-only WebTransport is rejected and the logical session remains usable on WebSocket', async t => {
  let closes = 0;
  const host = { url: 'https://game.test/twinwire', setAcceptor() {}, async close() {} };
  const server = await serverApi.createGameServer({ origins: [], allowMissingOrigin: true, webtransport: host,
    onSession(s) { s.onEvent = d => s.sendEvent(d); } });
  const client = new clientApi.GameClient({ url: `ws://127.0.0.1:${await server.listen()}/connect`, room: 'wt', rtc: false,
    websocket: u => new WebSocket(u), webtransport: { create() {
      return { ready: Promise.resolve(), closed: new Promise(() => {}), reliability: 'reliable-only', close() { closes++; } };
    } } });
  t.after(async () => { client.close(); await server.close(); });
  const events = []; client.onEvent = d => events.push(d);
  client.connect(); await until(() => closes === 1);
  assert.equal(client.transport, 'ws'); client.sendEvent({ ok: true }); await until(() => events.length === 1);
  assert.equal(server.sessions.size, 1);
});

test('proven standby WT resets retry debt and duplicate resets cannot postpone its next attempt', async t => {
  let claim,creates=0,session; const pending=[],offers=[];
  const host={url:'https://game.test/twinwire',setAcceptor(fn){claim=fn;},async close(){}};
  const server=await serverApi.createGameServer({origins:[],allowMissingOrigin:true,webtransport:host,
    endpoint:{probeIntervalMs:20,probeTimeoutMs:100},onSession(s){session=s;}});
  const client=new clientApi.GameClient({url:`ws://127.0.0.1:${await server.listen()}/connect`,room:'wt-backup',rtc:false,
    endpoint:{probeIntervalMs:20,probeTimeoutMs:100,preferredDatagram:'rtc',pathSwitchMarginMs:1000,pathSwitchHoldMs:0},
    websocket:url=>{const socket=new WebSocket(url);socket.addEventListener('message',event=>{
      if(typeof event.data==='string'){const message=JSON.parse(event.data);if(message.wt)offers.push(message.wt);if(message.t==='wt-offer')offers.push(message.d);}
    });return socket;},webtransport:{retryMs:100,create(){
      if(++creates<=3)throw Error('synthetic unavailable provider');
      const pair=memorySessions();pending.push(serverApi.acceptWebTransport(pair.b,claim,{unreliableDatagrams:true}));return pair.a;
    }}});
  t.after(async()=>{client.close();await server.close();await Promise.all(pending);});
  client.connect();await until(()=>client.status==='online'&&session);
  const link=(other)=>({open:true,bufferedAmount:0,close(){},send(bytes){const copy=bytes.slice();queueMicrotask(()=>other.receiveBinary(copy,'rtc'));return true;}});
  client.endpoint.attachDatagram(link(session.endpoint),'rtc');session.endpoint.attachDatagram(link(client.endpoint),'rtc');
  await until(()=>creates>=4&&client.endpoint.datagramProven('wt')&&session.endpoint.datagramProven('wt'),10000);
  assert.equal(client.transport,'rtc','WT is a healthy standby while RTC remains preferred');
  await sleep(1100); // the real server's one-second offer admission cooldown has elapsed
  const previous=creates,at=performance.now(),attempt=offers.at(-1).a;
  session.endpoint.dropDatagram(true,'wt');
  await until(()=>!client.endpoint.datagramProven('wt'));
  for(let n=0;n<2;n++)session.endpoint.sendControl({t:'wt-reset',e:session.epoch,a:attempt});
  await until(()=>creates>previous,600);
  assert.ok(performance.now()-at<600,'healthy backup proof must return retries to the 100ms base');
  assert.equal(client.id,session.id);
});

test('legacy missing reliability property needs explicit HTTP/3 host capability confirmation and real datagram proof', async t => {
  let claim;const pending=[];
  const host={url:'https://game.test/twinwire',setAcceptor(fn){claim=fn;},async close(){}};
  const server=await serverApi.createGameServer({origins:[],allowMissingOrigin:true,webtransport:host});
  const client=new clientApi.GameClient({url:`ws://127.0.0.1:${await server.listen()}/connect`,room:'wt-legacy-capability',rtc:false,
    websocket:url=>new WebSocket(url),webtransport:{create(){const pair=memorySessions();delete pair.a.reliability;
      pending.push(serverApi.acceptWebTransport(pair.b,claim,{unreliableDatagrams:true}));return pair.a;}}});
  t.after(async()=>{client.close();await server.close();await Promise.all(pending);});
  const states=[];client.onState=state=>states.push(state);client.connect();
  await until(()=>client.transport==='wt',2000);
  const session=server.sessions.get(client.id);await until(()=>session.endpoint.datagramProven('wt'));
  session.sendState(1,new Uint8Array([1]));session.flush();await until(()=>states.length===1);
  assert.equal(states[0].via,'wt');
});

test('closing before the binding stream arrives cancels the pending handshake promptly', async () => {
  const pair=memorySessions();
  const accepted=serverApi.acceptWebTransport(pair.b,()=>assert.fail('closed connection cannot claim'),{unreliableDatagrams:true});
  pair.a.close();
  await Promise.race([accepted,sleep(150).then(()=>{throw Error('closed handshake still owns a reader/timer');})]);
});

test('a live QUIC payload-limit reduction routes an oversized outbound state onto WebSocket',async t=>{
  let claim,pair;const pending=[];
  const host={url:'https://game.test/twinwire',setAcceptor(fn){claim=fn;},async close(){}};
  let session;const server=await serverApi.createGameServer({origins:[],allowMissingOrigin:true,webtransport:host,onSession(s){session=s;}});
  const client=new clientApi.GameClient({url:`ws://127.0.0.1:${await server.listen()}/connect`,room:'wt-mtu',rtc:false,syncPingMs:10,
    websocket:url=>new WebSocket(url),webtransport:{create(){pair=memorySessions();pending.push(serverApi.acceptWebTransport(pair.b,claim,{unreliableDatagrams:true}));return pair.a;}}});
  t.after(async()=>{client.close();await server.close();await Promise.all(pending);});
  const states=[];client.connect();await until(()=>client.transport==='wt'&&client.clock.synced&&session.endpoint.datagramProven('wt'));
  session.onState=state=>states.push(state.via);
  pair.a.datagrams.maxDatagramSize=1024;
  client.sendState(1,new Uint8Array(1080));client.flush();await until(()=>states.length===1);
  assert.deepEqual(states,['ws']);
});
