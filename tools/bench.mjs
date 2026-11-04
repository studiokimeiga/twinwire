import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const sdkRoot=process.env.TWINWIRE_SDK_ROOT?path.resolve(process.env.TWINWIRE_SDK_ROOT):fileURLToPath(new URL('../',import.meta.url));
const {createGameServer}=await import(pathToFileURL(path.join(sdkRoot,'dist/server/index.js')));
const {GameClient,StateTraceBuffer}=await import(pathToFileURL(path.join(sdkRoot,'dist/client/index.js')));
const sdkVersion=JSON.parse(await readFile(path.join(sdkRoot,'package.json'),'utf8')).version;
import { monitorEventLoopDelay } from 'node:perf_hooks';
const option=(name,value)=>{const i=process.argv.indexOf(name);return i<0?value:Number(process.argv[i+1]);};
const count=option('--clients',50), hz=option('--hz',20), seconds=option('--seconds',3), neighbors=option('--neighbors',8);
if(![count,hz,seconds,neighbors].every(Number.isFinite)||count<1||count>200||hz<1||hz>120||seconds<1||seconds>120||neighbors<0||neighbors>=count)throw new Error('Invalid benchmark options');
const errors=[],clients=[],peers=[];let rawMessages=0;
const traceEnabled=process.env.TWINWIRE_TRACE==='1',recorder=traceEnabled?new StateTraceBuffer(512):undefined;
let traced=0;const endpoint=recorder?{trace:event=>{traced++;recorder.record(event);}}:undefined;
const server=await createGameServer({origins:[],allowMissingOrigin:true,maxPerIp:count,maxSessions:count,maxConnections:count+4,onError:e=>errors.push(e.message),
 endpoint,
 onSession(session){const id=peers.length;peers.push(session);session.onState=s=>{rawMessages++;for(let j=1;j<=neighbors;j++){const peer=peers[(id+j)%count];if(peer)peer.sendState(id,s.data,{ttlMs:100});}};}});
const port=await server.listen(); const startDeadline=performance.now()+10000;
for(let i=0;i<count;i++){const c=new GameClient({url:`ws://127.0.0.1:${port}/connect`,room:'bench',rtc:false,endpoint});c.onError=e=>errors.push(e.message);clients.push(c);c.connect();}
while(!clients.every(c=>c.status==='online'&&c.clock.synced)){if(performance.now()>startDeadline)throw new Error('Join timeout');await new Promise(r=>setTimeout(r,10));}
const cpu=process.cpuUsage(), begin=performance.now(), lag=monitorEventLoopDelay({resolution:10});lag.enable();let sends=0;
const timer=setInterval(()=>{sends++;for(let i=0;i<clients.length;i++){const b=new Uint8Array(16);new DataView(b.buffer).setFloat32(0,sends+i,true);clients[i].sendState(0,b);clients[i].flush();}},1000/hz);
await new Promise(r=>setTimeout(r,seconds*1000));clearInterval(timer);await new Promise(r=>setTimeout(r,100));
const elapsed=(performance.now()-begin)/1000,used=process.cpuUsage(cpu);lag.disable();
const down=peers.reduce((n,p)=>n+p.endpoint.stats.bytesSent,0),received=clients.reduce((n,p)=>n+p.endpoint.stats.statesReceived,0);
const result={kind:'localhost-single-process-websocket',sdkVersion,node:process.version,clients:count,hz,neighbors,seconds:elapsed,
 incomingStates:rawMessages,deliveredStates:received,serverEncodedBytesSent:down,serverEncodedBytesPerSecond:down/elapsed,
 perClientEncodedBytesPerSecond:down/elapsed/count,cpuMsIncludingClients:(used.user+used.system)/1000,
 rssMB:process.memoryUsage().rss/1048576,eventLoopP99Ms:lag.percentile(99)/1e6,errors,
 trace:{enabled:traceEnabled,recorded:traced,retained:recorder?.snapshot().length??0,overwritten:recorder?.overwritten??0},
 caveat:'Includes clients and server in one process. Not a VPS, native WebRTC, cellular, or complete game simulation benchmark. Counts encoded application traffic, not IP/TLS/provider-billed bytes.'};
for(const c of clients)c.close();await server.close();console.log(JSON.stringify(result,null,2));if(errors.length)process.exitCode=1;
