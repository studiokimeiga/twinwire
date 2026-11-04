// Real browser QUIC churn with retained game state, offline events, checkpoint reloads and unbound hostile peers.
// Run on a supported HTTP/3 host. Application impairment is explicit; this is not a cellular/network-shaper test.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {X509Certificate,createHash} from 'node:crypto';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import {chromium,firefox} from 'playwright';
import {createGameServer,createWebTransportHost} from '../dist/server/index.js';
const engine=process.env.ENGINES??'chromium';
const seconds=Number(process.env.WT_SOAK_SECONDS)||Number(process.env.SOAK_MINUTES??60)*60;
const count=16,hostile=6;
if(!['chromium','firefox'].includes(engine)||!Number.isFinite(seconds)||seconds<30||seconds>7200)throw Error('Invalid soak configuration');
const directory=await mkdtemp(path.join(os.tmpdir(),'twinwire-wt-soak-'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let host,server,browser,ticker,probeTimer;
const errors=[],samples=[];
const lag=monitorEventLoopDelay({resolution:10});
const report={kind:'real-browser-http3-lifecycle-soak',engine,seconds,clients:count,hostile,
  impairment:{lagMs:20,jitterMs:10,loss:.03},node:process.version,
  limits:'One browser, native server and localhost runner. Application-level loss/delay, not a full network emulator. Heap excludes the browser; RSS includes native provider allocations.'};
try {
  execFileSync('openssl',['req','-new','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-sha256','-days','2',
    '-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost','-keyout',path.join(directory,'key.pem'),'-out',path.join(directory,'cert.pem')],{stdio:'ignore'});
  const cert=await readFile(path.join(directory,'cert.pem'),'utf8'),privKey=await readFile(path.join(directory,'key.pem'),'utf8');
  const hash=Array.from(createHash('sha256').update(new X509Certificate(cert).raw).digest());
  host=await createWebTransportHost({url:'https://127.0.0.1:0/twinwire',port:0,host:'127.0.0.1',cert,privKey,maxConnections:64});
  const bundle=await readFile(new URL('../dist/browser/twinwire.js',import.meta.url));
  server=await createGameServer({origins:[],webtransport:host,resumeGraceMs:8000,allowImpairment:true,maxPerIp:32,maxSessions:32,
    onError:error=>errors.push(error.message),
    http(req,res){res.writeHead(200,{'content-type':req.url==='/twinwire.js'?'text/javascript':'text/html'});
      res.end(req.url==='/twinwire.js'?bundle:'<!doctype html><canvas id="world" width="640" height="360"></canvas><script src="/twinwire.js"></script>');},
    onSession(session,resumed){
      if(!resumed)session.data={score:0,x:0};
      session.onEvent=data=>{if(data?.inc===1){session.data.score++;session.sendEvent({score:session.data.score});}};
      session.onState=state=>{if(state.stream===1&&state.data.length===4){const x=new DataView(state.data.buffer,state.data.byteOffset).getFloat32(0,true);
        if(Number.isFinite(x))session.data.x=Math.max(0,Math.min(1e6,x));}};
    }});
  const origin=`http://127.0.0.1:${await server.listen()}`;server.options.origins.push(origin);
  let tick=0;ticker=setInterval(()=>{tick++;for(const session of server.sessions.values())if(session.connected){
    const bytes=new Uint8Array(12),view=new DataView(bytes.buffer);view.setFloat32(0,session.data.x,true);view.setUint32(4,session.data.score,true);view.setUint32(8,tick,true);
    session.sendState(2,bytes);session.flush();}},50);
  browser=await({chromium,firefox}[engine]).launch({headless:true,args:engine==='chromium'?['--no-sandbox']:[]});
  report.browser=browser.version();const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);
  await page.evaluate(({hash,count,hostUrl})=>{
    if(typeof WebTransport!=='function')throw Error('A requested QUIC soak needs native WebTransport');
    const T=window.T={players:[],errors:[],finished:false,renderFrames:0,churns:0,checkpoints:0,hostiles:[],ageBuckets:new Uint32Array(251)};
    const options={rtc:false,webtransport:{retryMs:100,serverCertificateHashes:[{algorithm:'sha-256',value:new Uint8Array(hash)}]},
      impair:{lagMs:20,jitterMs:10,loss:.03},endpoint:{bytesPerSecond:32768}};
    const create=(player,checkpoint)=>{
      const c=player.client=new Twinwire.GameClient({...options,url:'ws://'+location.host+'/connect',room:'wt-soak',checkpoint});
      const timeline=player.timeline=new Twinwire.Timeline(),playback=new Twinwire.AdaptivePlayback(50);
      player.receiver=c.receiveState({stream:2,playback,resume:'retain',reset:()=>timeline.clear(),apply:state=>{
        if(state.data.length!==12)return false;const view=new DataView(state.data.buffer,state.data.byteOffset,state.data.byteLength);
        const world={x:view.getFloat32(0,true),score:view.getUint32(4,true),tick:view.getUint32(8,true)};
        if(world.tick<player.lastTick)T.errors.push('world tick regressed');player.lastTick=world.tick;player.world=world;player.received++;
        if(state.via==='wt')player.quic++;
        if(c.clock.synced){const now=c.clock.serverTime(performance.now());playback.track(timeline,{time:state.time,seq:state.seq,value:world},now);
          if(c.clock.uncertaintyMs<50)T.ageBuckets[Math.max(0,Math.min(250,Math.floor(now-state.time)))]++;}
        else timeline.insert({time:state.time,seq:state.seq,value:world});return true;
      }});
      c.onSession=info=>{if(player.id&&player.id!==info.id)T.errors.push('logical identity changed');player.id=info.id;if(info.resumed)player.resumes++;};
      c.onEvent=data=>{if(data.score!==player.lastScore+1)T.errors.push('reliable score duplicate/gap');player.lastScore=data.score;};
      c.onError=error=>T.errors.push(error.message);
      c.onStatus=status=>{if(status==='lost'&&!T.finished)T.errors.push('honest session lost');};
      c.connect();
    };
    for(let i=0;i<count;i++){const p={id:null,target:i,expectedScore:0,lastScore:0,lastTick:0,received:0,quic:0,resumes:0};T.players.push(p);create(p);}
    T.input=setInterval(()=>{for(const p of T.players){p.target+=.1;const b=new Uint8Array(4);new DataView(b.buffer).setFloat32(0,p.target,true);p.client.sendState(1,b);p.client.flush();}},100);
    T.events=setInterval(()=>{for(const p of T.players){p.expectedScore++;p.client.sendEvent({inc:1});}},1000);
    T.cycle=()=>{T.churns++;const p=T.players[T.churns%T.players.length];p.client.simulateDrop();
      const q=T.players[(T.churns+5)%T.players.length];q.client.pause();q.expectedScore++;q.client.sendEvent({inc:1});setTimeout(()=>q.client.resume(),500);
      if(T.churns%3===0){const r=T.players[(T.churns+10)%T.players.length],checkpoint=r.client.checkpoint();r.client.pause();create(r,checkpoint);T.checkpoints++;}
      for(let i=0;i<6;i++){const wt=new WebTransport(hostUrl,{serverCertificateHashes:[{algorithm:'sha-256',value:new Uint8Array(hash)}]});
        wt.ready.catch(()=>{});wt.closed.catch(()=>{});setTimeout(()=>wt.close(),1500);}
    };
    T.churn=setInterval(T.cycle,10000);
    const canvas=document.querySelector('#world'),ctx=canvas.getContext('2d');let last=performance.now();
    const render=now=>{if(T.finished)return;const dt=Math.max(0,now-last);last=now;ctx.clearRect(0,0,640,360);
      for(let i=0;i<T.players.length;i++){const p=T.players[i],at=p.receiver.advance(dt);if(at===null)continue;
        const sample=p.timeline.sample(at,(a,b,t)=>({...b,x:a.x+(b.x-a.x)*t}));if(sample){ctx.fillRect(sample.value.x%630,10+i*20,5,5);p.rendered=sample.value;}}
      T.renderFrames++;requestAnimationFrame(render);};requestAnimationFrame(render);
  },{hash,count,hostUrl:host.url});
  const ready=()=>page.waitForFunction(()=>T.players.every(p=>p.client.transport==='wt'&&p.receiver.ready&&p.quic>0),undefined,{timeout:30000});
  await ready();globalThis.gc?.();lag.enable();const begin=performance.now();
  const sample=async()=>{
    const client=await page.evaluate(()=>({errors:T.errors.slice(0,20),churns:T.churns,checkpoints:T.checkpoints,renderFrames:T.renderFrames,
      players:T.players.map(p=>({received:p.received,quic:p.quic,resumes:p.resumes,score:p.lastScore,expected:p.expectedScore,status:p.client.status,path:p.client.transport,pending:p.client.endpoint.events.size}))}));
    assert.deepEqual(client.errors,[]);assert.deepEqual(errors,[]);assert.equal(server.sessions.size,count);
    globalThis.gc?.();const memory=process.memoryUsage();const row={elapsedSeconds:(performance.now()-begin)/1000,heapMB:memory.heapUsed/1048576,rssMB:memory.rss/1048576,
      eventLoopP99Ms:lag.percentile(99)/1e6,...client};samples.push(row);console.log(JSON.stringify(row));
  };
  await sample();
  while(performance.now()-begin<seconds*1000){await sleep(Math.min(30000,seconds*1000-(performance.now()-begin)));await sample();}
  await page.evaluate(()=>{clearInterval(T.input);clearInterval(T.events);clearInterval(T.churn);});
  await ready();
  await page.waitForFunction(()=>T.players.every(p=>p.client.endpoint.events.size===0&&p.lastScore===p.expectedScore&&p.world?.score===p.expectedScore&&p.rendered?.score===p.expectedScore),undefined,{timeout:20000});
  report.elapsedSeconds=(performance.now()-begin)/1000;report.final=await page.evaluate(()=>({churns:T.churns,checkpoints:T.checkpoints,renderFrames:T.renderFrames,
    players:T.players.map(p=>({id:p.id,received:p.received,quic:p.quic,resumes:p.resumes,score:p.lastScore,expected:p.expectedScore}))}));
  for(const p of report.final.players){assert.ok(p.quic>seconds*5,'honest player stopped receiving QUIC state');assert.equal(p.score,p.expected);}
  assert.ok(report.final.renderFrames>seconds*10,'browser rendering stopped');
  const warm=samples[Math.min(1,samples.length-1)];
  assert.ok(Math.max(...samples.map(s=>s.heapMB))-warm.heapMB<32,'Node heap grew >32MiB after warmup');
  assert.ok(Math.max(...samples.map(s=>s.rssMB))-warm.rssMB<128,'native/Node RSS grew >128MiB after warmup');
  assert.ok(lag.percentile(99)/1e6<50,'Node event-loop p99 exceeded50ms');
  await page.evaluate(()=>{T.finished=true;for(const p of T.players)p.client.close();});await browser.close();browser=undefined;
  const drain=performance.now()+10000;while(server.sessions.size&&performance.now()<drain)await sleep(20);
  assert.equal(server.sessions.size,0,'logical sessions did not drain');report.drained=server.metrics();report.pass=true;
}catch(error){report.pass=false;report.error=error.stack;process.exitCode=1;}
finally{
  lag.disable();clearInterval(ticker);clearInterval(probeTimer);await browser?.close();if(server)await server.close();else await host?.close();
  await sleep(100);report.resourcesAfterClose=process.getActiveResourcesInfo().filter(name=>/UDP|TCPServer|TCPSocket|Timeout/.test(name));
  if(report.resourcesAfterClose.length){report.pass=false;report.resourceError='Owned network/timer resources remained';process.exitCode=1;}
  report.samples=samples;report.errors=errors;
  await mkdir(new URL('../validation/',import.meta.url),{recursive:true});
  await writeFile(new URL(`../validation/webtransport-soak-${engine}.json`,import.meta.url),JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,samples:report.samples.length}));
  assert.ok(directory.startsWith(path.join(os.tmpdir(),'twinwire-wt-soak-')));await rm(directory,{recursive:true,force:true});
}
