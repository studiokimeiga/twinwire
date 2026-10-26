// Exercise the published Worker entry in a real workerd Durable Object, not a Node socket mock.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,Log,LogLevel} from 'miniflare';
import WebSocket from 'ws';
import {GameClient} from '../dist/client/index.js';
const source = [
  "import {SocketSessionServer} from './dist/worker.js';",
  "export class Room {",
  " constructor(){this.errors=[];this.host=new SocketSessionServer({origins:['https://game.test'],resumeGraceMs:2000,onError:e=>this.errors.push(e.message),onSession:(s,resumed)=>{if(!resumed){s.onEvent=data=>s.sendEvent(data);s.onState=st=>s.sendState(st.stream,st.data);}}});}",
  " async fetch(request){if(new URL(request.url).pathname==='/stats')return Response.json({sessions:this.host.sessions.size,...this.host.stats,errors:this.errors});if(!this.host.allowsOrigin(request.headers.get('origin')??''))return new Response('origin',{status:403});const pair=new WebSocketPair();pair[1].accept();this.host.accept(pair[1],{origin:request.headers.get('origin')??'',ip:'test'});return new Response(null,{status:101,webSocket:pair[0]});}",
  "}",
  "export default {fetch(request,env){return env.ROOM.get(env.ROOM.idFromName('test')).fetch(request);}};",
].join('\n');
const bundle=await build({stdin:{contents:source,resolveDir:process.cwd(),sourcefile:'worker-conformance.mjs'},bundle:true,format:'esm',platform:'browser',write:false});
const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2025-01-01',durableObjects:{ROOM:'Room'},log:new Log(LogLevel.ERROR)});
const clients=[],url=await mf.ready;
const wsUrl=url.href.replace(/^http/,'ws')+'connect';
const make=extra=>{const c=new GameClient({url:wsUrl,room:'test',rtc:false,reconnectBaseMs:30,websocket:u=>new WebSocket(u,{origin:'https://game.test'}),...extra});clients.push(c);return c;};
const wait=async(predicate,ms=8000)=>{const end=performance.now()+ms;while(!predicate()){if(performance.now()>end)throw Error('Timed out waiting for workerd');await new Promise(r=>setTimeout(r,10));}};
try{
 const c=make(),events=[],states=[];c.onEvent=e=>events.push(e);c.onState=s=>states.push(s);c.connect();
 await wait(()=>c.status==='online'&&c.clock.synced);const id=c.id;
 c.sendEvent({type:'ping',n:1});await wait(()=>events.length===1);
 c.sendState(7,Uint8Array.of(4,2));await wait(()=>states.length===1);assert.deepEqual([...states[0].data],[4,2]);
 c.pause();c.sendEvent({type:'ping',n:2});c.connect();await wait(()=>events.length===2);assert.equal(c.id,id);
 assert.deepEqual(events,[{type:'ping',n:1},{type:'ping',n:2}]);
 const cp=c.checkpoint(),takeover=make({checkpoint:cp});takeover.connect();await wait(()=>takeover.status==='online');await wait(()=>c.status==='lost');
 assert.equal(takeover.id,id);takeover.sendEvent({type:'ping',n:3});let received=0;takeover.onEvent=()=>received++;await wait(()=>received===1);
 const denied=await fetch(new URL('/connect',url),{headers:{origin:'https://evil.test'}});assert.equal(denied.status,403);
 const stats=await fetch(new URL('/stats',url)).then(r=>r.json());
 assert.equal(stats.sessions,1);assert.equal(stats.sessionResumes,2);assert.deepEqual(stats.errors,[]);
 console.log(JSON.stringify({ok:true,runtime:'workerd',sameSession:id,binaryEcho:true,orderedReplay:true,takeover:true,originRejected:true,stats}));
}finally{clients.forEach(c=>c.close());await mf.dispose();}
