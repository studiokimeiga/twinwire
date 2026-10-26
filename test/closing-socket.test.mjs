
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {GameClient} from '../dist/client/index.js';
import {createGameServer} from '../dist/server/index.js';
import {sleep,until} from './helpers.mjs';

for(const mode of ['closing','silent-open']) test('a stalled '+mode+' socket cannot hold an online session or block recovery',async()=>{
 const server=await createGameServer({origins:[],allowMissingOrigin:true});const port=await server.listen();
 let first,created=0;const sockets=[],echoes=[];server.on('session',(session,resumed)=>{session.onEvent=data=>{echoes.push(data);session.sendEvent(data);};});
 const client=new GameClient({url:'ws://127.0.0.1:'+port+'/connect',room:'closing',rtc:false,heartbeatTimeoutMs:100,reconnectBaseMs:10,websocket:url=>{
   const socket=new WebSocket(url);sockets.push(socket);if(created++)return socket;
   first={blocked:false,closing:false,closeCalls:0};
   const wrapper={
     get readyState(){return first.closing?2:socket.readyState;},get bufferedAmount(){return socket.bufferedAmount;},
     set binaryType(value){socket.binaryType=value;},
     set onopen(fn){socket.onopen=fn;},set onerror(fn){socket.onerror=fn;},
     set onmessage(fn){first.deliver=fn;socket.onmessage=e=>{if(!first.blocked)fn(e);};},
     set onclose(fn){first.closed=fn;socket.onclose=e=>{if(!first.blocked)fn(e);};},
     send(data){if(!first.blocked)socket.send(data);},
     close(){first.closeCalls++;if(first.blocked){first.closing=true;return;}socket.close();},
   };return wrapper;
 }});
 const states=[],events=[],statuses=[];const receiver=client.receiveState({stream:1,maxExtrapolationMs:1000,apply:s=>{states.push(s.data[0]);return true;}});
 client.onEvent=e=>events.push(e);client.onStatus=s=>statuses.push(s);
 try{
   client.connect();await until(()=>client.status==='online'&&client.clock.synced);
   const id=client.id;server.sessions.get(id).sendState(1,Uint8Array.of(7));await until(()=>receiver.ready);
   first.blocked=true;first.closing=mode==='closing';
   client.sendEvent({queued:'exactly once'});
   await until(()=>created>=2,1500);
   await until(()=>client.status==='online'&&server.stats.sessionResumes===1);
   assert.equal(client.id,id);assert.equal(receiver.ready,false,'a new socket cannot release old playback');
   await until(()=>echoes.length===1&&events.length===1);
   assert.deepEqual(events,[{queued:'exactly once'}]);assert.ok(statuses.includes('connecting'));
   first.closed({code:4002,reason:'late close from retired socket'});await sleep(30);
   assert.equal(client.status,'online','a retired socket cannot terminate the resumed connection');
   server.sessions.get(id).sendState(1,Uint8Array.of(8));await until(()=>receiver.ready);
   assert.deepEqual(states,[7,8]);assert.equal(echoes.length,1);
 }finally{client.close();for(const socket of sockets)socket.terminate();await server.close();}
});
