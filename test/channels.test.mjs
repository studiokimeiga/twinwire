import test from 'node:test';
import assert from 'node:assert/strict';
import {createEventServer} from '../dist/server/index.js';
import {EventClient,createEventClient} from '../dist/client/index.js';
import {until,sleep} from './helpers.mjs';
async function setup(extra={}){
  const server=await createEventServer({namespace:'arena',latest:{position:1},origins:['http://localhost'],allowMissingOrigin:true,resumeGraceMs:250,...extra});
  const port=await server.listen();
  const clients=[];
  const make=()=>{
    const client=new EventClient({url:'ws://127.0.0.1:'+port+'/connect',room:'arena',rtc:false,reconnectBaseMs:20,latest:{position:1}});
    clients.push(client);return client;
  };
  return {server,make,async close(){for(const c of clients)c.close();await server.close();}};
}
test('named events keep handlers, identity and room membership across a resume',async()=>{
  const s=await setup();let created=0,expired=0,paused=0,received=0;
  s.server.onConnection(channel=>{
    created++;channel.join('one');channel.onDisconnect(()=>expired++);
    channel.onPause=()=>paused++;
    channel.on('ping',data=>{received++;channel.emit('pong',data);});
  });
  const c=s.make(),pongs=[];c.on('pong',d=>pongs.push(d));c.connect();
  try{
    await c.net.whenOnline();const id=c.id;
    c.emit('ping',{n:1});await until(()=>pongs.length===1);
    c.net.pause();await until(()=>paused===1);
    c.emit('ping',{n:2});c.connect();await until(()=>pongs.length===2);
    assert.equal(c.id,id);assert.equal(created,1);assert.equal(expired,0);assert.equal(received,2);
    assert.equal(s.server.channels.size,1);
    assert.equal(s.server.channels.get(id).rooms.has('one'),true);
    c.close();await until(()=>expired===1);
    assert.equal(s.server.channels.size,0);assert.equal(s.server.roomCount,0);
  }finally{await s.close();}
});
test('named latest state uses recovery gates and independent streams',async()=>{
  const s=await setup();let channel;const states=[];
  s.server.onConnection(c=>{channel=c;c.on('position',data=>states.push(data));});
  const c=s.make(),positions=[];c.on('position',d=>positions.push(d));c.connect();
  try{
    await until(()=>c.net.status==='online'&&c.net.clock.synced);
    channel.emit('position',{x:1});
    await until(()=>positions.length===1);
    assert.equal(c.ready('position'),true);
    assert.equal(c.net.endpoint.stats.statesReceived,1);
    c.net.pause();assert.equal(c.ready('position'),false);
    c.connect();await until(()=>c.net.status==='online'&&c.net.clock.synced);
    assert.equal(c.ready('position'),false);
    channel.emit('position',{x:2});await until(()=>positions.length===2);
    assert.equal(c.ready('position'),true);
    c.emit('position',{x:3});await until(()=>states.length===1);
    assert.deepEqual(states,[{x:3}]);
  }finally{await s.close();}
});
test('room broadcasts stay private and sender broadcast excludes itself',async()=>{
  const s=await setup(),channels=[];
  s.server.onConnection(c=>{channels.push(c);c.join(channels.length===3?'other':'one');});
  const clients=[s.make(),s.make(),s.make()],received=clients.map(()=>[]);
  clients.forEach((c,i)=>{c.on('chat',d=>received[i].push(d));c.connect();});
  try{
    await until(()=>clients.every(c=>c.net.status==='online'));
    s.server.room('one').emit('chat','private');
    await until(()=>received.flat().length===2);
    assert.deepEqual(received,[['private'],['private'],[]]);
    channels[0].broadcast.emit('chat','others');
    await until(()=>received.flat().length===4);
    assert.deepEqual(received,[['private'],['private','others'],['others']]);
  }finally{await s.close();}
});
test('a named-state callback must accept a snapshot before it releases recovery',async()=>{
  const s=await setup();let channel,accept=false;
  s.server.onConnection(c=>{channel=c;});
  const c=s.make();c.on('position',()=>accept);c.connect();
  try{
    await until(()=>c.net.status==='online'&&c.net.clock.synced);
    channel.emit('position',{x:1});await sleep(60);assert.equal(c.ready('position'),false);
    accept=true;channel.emit('position',{x:2});await until(()=>c.ready('position'));
  }finally{await s.close();}
});
test('channel schemas reject ambiguous names, duplicate streams and reserved names',()=>{
  for(const latest of [{a:1,b:1},{a:0},{a:-1},{a:65536},{'':1},{'$control':1}]){
    assert.throws(()=>new EventClient({url:'ws://localhost/connect',room:'arena',latest}));
  }
});

test('closing an auto-connect channel in its creation task cannot resurrect its socket',async()=>{
 let opened=0;
 const c=createEventClient({url:'ws://127.0.0.1:1/connect',room:'test',rtc:false,websocket:()=>{opened++;throw Error('closed client opened a socket');}});
 try{c.close();await sleep(5);assert.equal(c.net.status,'closed');assert.equal(opened,0);}
 finally{c.close();}
});
