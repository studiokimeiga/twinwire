import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {WebSocketServer,WebSocket} from 'ws';
import {SocketSessionServer} from '../dist/worker.js';
import {GameClient} from '../dist/client/index.js';
import {until,sleep} from './helpers.mjs';
async function setup(options={}){
 const errors=[],host=new SocketSessionServer({origins:['http://game.test'],resumeGraceMs:120,onError:e=>errors.push(e.message),...options});
 const httpServer=http.createServer(),wss=new WebSocketServer({noServer:true});
 httpServer.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>host.accept(ws,{origin:req.headers.origin??'',ip:'test'})));
 await new Promise(r=>httpServer.listen(0,'127.0.0.1',r));
 const clients=[],url='ws://127.0.0.1:'+httpServer.address().port+'/connect';
 const client=(extra={})=>{const c=new GameClient({url,room:'test',rtc:false,reconnectBaseMs:20,websocket:u=>new WebSocket(u,{origin:'http://game.test'}),...extra});clients.push(c);return c;};
 return {host,errors,client,async close(){clients.forEach(c=>c.close());host.close();wss.close();await new Promise(r=>httpServer.close(r));}};
}
test('Worker socket adapter resumes one session and replays an offline event once',async()=>{
 const received=[];let created=0,paused=0;
 const s=await setup({onSession(session,resumed){if(!resumed){created++;session.onEvent=d=>{received.push(d);session.sendEvent(d);};}},onDisconnect(){paused++;}});
 const c=s.client(),echo=[];c.onEvent=d=>echo.push(d);c.connect();
 try{
  await c.whenOnline();const id=c.id;c.sendEvent({n:1});await until(()=>echo.length===1);
  c.pause();await until(()=>paused===1);c.sendEvent({n:2});c.connect();await until(()=>echo.length===2);
  assert.equal(c.id,id);assert.equal(created,1);assert.deepEqual(received,[{n:1},{n:2}]);assert.equal(s.host.sessions.size,1);
  assert.deepEqual(s.errors,[]);
 }finally{await s.close();}
});
test('Worker socket adapter carries binary states both ways using the shared wire',async()=>{
 let session;const s=await setup({onSession(s){session=s;s.onState=state=>s.sendState(2,state.data);}});
 const c=s.client(),received=[];c.onState=state=>received.push(state);c.connect();
 try{
  await until(()=>c.status==='online'&&c.clock.synced);c.sendState(1,Uint8Array.of(4,2));await until(()=>received.length===1);
  assert.equal(received[0].stream,2);assert.deepEqual([...received[0].data],[4,2]);assert.equal(session.transport,'ws');
 }finally{await s.close();}
});
test('Worker socket adapter expires disconnected sessions and rejects old tokens',async()=>{
 let expired=0;const s=await setup({onExpire(){expired++;}}),c=s.client();c.connect();
 try{
  await c.whenOnline();c.pause();await until(()=>expired===1);c.connect();await until(()=>c.status==='lost');
  assert.equal(s.host.sessions.size,0);
 }finally{await s.close();}
});
test('Worker socket adapter fences the retired socket during session takeover',async()=>{
 let effects=0;const s=await setup({onSession(session,resumed){if(!resumed)session.onEvent=()=>effects++;}});
 const a=s.client();a.connect();let b;
 try{
  await a.whenOnline();const cp=a.checkpoint();b=s.client({checkpoint:cp});b.connect();await b.whenOnline();
  await until(()=>a.status==='lost');b.sendEvent('current');await until(()=>effects===1);
  assert.equal(b.id,cp.id);assert.equal(s.host.sessions.size,1);
 }finally{await s.close();}
});
test('Worker socket adapter revalidates authentication and room binding on resume',async()=>{
 let authorized=true;const s=await setup({authenticate:()=>authorized?'subject':null}),c=s.client();c.connect();
 try{
  await c.whenOnline();c.pause();await until(()=>!s.host.sessions.get(c.id).connected);authorized=false;c.connect();
  await sleep(80);assert.notEqual(c.status,'online');assert.equal(s.host.stats.sessionResumes,0);
 }finally{await s.close();}
});
test('Worker adapter origin policy is exact and pure/browser bundle has no Node dependencies',()=>{
 const s=new SocketSessionServer({origins:['https://game.test']});
 assert.equal(s.allowsOrigin('https://game.test'),true);assert.equal(s.allowsOrigin('https://evil.test'),false);assert.equal(s.allowsOrigin(''),false);
 assert.throws(()=>new SocketSessionServer({origins:['*']}));
 s.close();
});
