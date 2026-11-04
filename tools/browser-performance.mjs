// Real rendered Canvas scene, real SDK sockets. Each sample owns a fresh server and browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {fork} from 'node:child_process';
import {createHash} from 'node:crypto';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {assertCaptureWindow} from './browser-performance-analysis.mjs';
const ownFile=fileURLToPath(import.meta.url);
const option=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
const profiles={
 normal:{rate:262144,burst:65536,eventHz:0,eventBytes:0,entities:240},
 'mixed-budget':{rate:4000,burst:200,eventHz:100,eventBytes:600,entities:240},
 'render-load':{rate:262144,burst:65536,eventHz:0,eventBytes:0,entities:12000},
};
const hash=b=>createHash('sha256').update(b).digest('hex');
const browserHTML=String.raw`<!doctype html><meta charset="utf-8"><title>Twinwire rendered performance scene</title>
<canvas id="scene" width="640" height="360" style="width:100%;max-width:640px"></canvas>
<script src="/sdk.js"></script><script>
window.B={errors:[],start(pathName,entities){
 const canvas=document.getElementById('scene'),g=canvas.getContext('2d');
 const c=this.client=new Twinwire.GameClient({url:'ws://'+location.host+'/connect',room:'performance-scene',rtc:pathName==='rtc'?{}:false,webtransport:false,syncPingMs:100});
 this.entities=entities;this.latest=null;this.receipts=[];this.renderAges=[];this.heldAges=[];this.eventAges=[];this.frameIntervals=[];this.uncertainties=[];this.lastEvent=0;this.events=0;this.received=0;this.draws=0;this.paths={};
 c.onError=e=>this.errors.push(e.message);
 c.onEvent=e=>{if(e.n!==this.lastEvent+1)this.errors.push('event sequence gap');this.lastEvent=e.n;if(this.measuring){this.events++;this.eventAges.push(c.clock.serverTime(performance.now())-e.at);}};
 c.onState=s=>{
  if(s.stream!==1||s.data.byteLength!==20){this.errors.push('invalid state');return;}
  const v=new DataView(s.data.buffer,s.data.byteOffset,s.data.byteLength);this.latest={at:v.getFloat64(0,true),tick:v.getUint32(8,true),x:v.getFloat32(12,true),y:v.getFloat32(16,true)};
  if(this.measuring){this.received++;this.paths[s.via]=(this.paths[s.via]||0)+1;this.receipts.push(c.clock.serverTime(performance.now())-this.latest.at);}
 };
 let prior=null,priorSourceTime=null,animation;
 const draw=now=>{
  if(this.measuring&&priorSourceTime!==null)this.heldAges.push(c.clock.serverTime(performance.now())-priorSourceTime);
  g.fillStyle='#10172a';g.fillRect(0,0,640,360);
  const shift=this.latest?this.latest.x:0;
  // Identical live drawing work for every SDK. No suppressed raster calls or idle scene.
  for(let i=0;i<entities;i++){
   if(i%32===0)g.fillStyle=i%64?'#a5b4fc':'#fbbf24';
   g.fillRect((i*37+shift)%640,(i*19+now/40)%360,3,3);
  }
  if(this.latest){g.fillStyle='#fff';g.fillRect(this.latest.x,this.latest.y,12,12);}
  if(this.measuring){
   this.draws+=entities+2;
   if(prior!==null)this.frameIntervals.push(now-prior);
   if(this.latest){this.renderAges.push(c.clock.serverTime(performance.now())-this.latest.at);this.uncertainties.push(c.clock.uncertaintyMs);}
  }
  prior=now;if(this.latest)priorSourceTime=this.latest.at;animation=requestAnimationFrame(draw);
 };
 this.freeze=()=>cancelAnimationFrame(animation);animation=requestAnimationFrame(draw);c.connect();
},begin(){this.measuring=true;this.started=performance.now();this.receipts=[];this.renderAges=[];this.heldAges=[];this.eventAges=[];this.frameIntervals=[];this.uncertainties=[];this.events=0;this.received=0;this.draws=0;this.paths={};void fetch('/measure',{method:'POST'});},
finish(){this.measuring=false;this.freeze();const elapsedMs=performance.now()-this.started;
 const metric=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),p=q=>b[Math.max(0,Math.ceil(b.length*q)-1)];return{n:b.length,min:b[0],p50:p(.5),p95:p(.95),p99:p(.99),max:b.at(-1)};};
 const result={elapsedMs,status:this.client.status,transport:this.client.transport,receivedStates:this.received,receivedEvents:this.events,paths:this.paths,
  receiptAgeMs:metric(this.receipts),renderSubmissionAgeMs:metric(this.renderAges),previousSubmissionAgeAtNextFrameMs:metric(this.heldAges),reliableEventAgeMs:metric(this.eventAges),frameIntervalMs:metric(this.frameIntervals),clockUncertaintyMs:metric(this.uncertainties),
  averageFrameCallbacksPerSecond:this.frameIntervals.length/(elapsedMs/1000),drawCalls:this.draws,errors:[...this.errors]};
 this.client.close();return result;}};
</script>`;

async function serverProcess(){
 const sdk=path.resolve(option('--sdk','')),profile=profiles[option('--profile','normal')],transport=option('--transport','ws');assert.ok(profile);assert.ok(['ws','rtc'].includes(transport));
 const shareOption=option('--state-share',undefined),stateBudgetShare=shareOption===undefined?undefined:Number(shareOption);
 assert.ok(stateBudgetShare===undefined||Number.isFinite(stateBudgetShare)&&stateBudgetShare>0&&stateBudgetShare<1);
 const {createGameServer,createNativeRtcFactory}=await import(pathToFileURL(sdk+'/dist/server/index.js'));
 const bundle=fs.readFileSync(sdk+'/dist/browser/twinwire.js');
 const errors=[];let server,timer,session,cpuStart,begin,lag,startStats;
 let counters={statesRequested:0,eventsQueued:0,eventsRejected:0,budgetedEventBytes:0,maxEncodedEventBytes:0};
 const measure=()=>{assert.ok(!cpuStart,'Only one measurement window per sample');counters={statesRequested:0,eventsQueued:0,eventsRejected:0,budgetedEventBytes:0,maxEncodedEventBytes:0};startStats={...session.endpoint.stats};cpuStart=process.cpuUsage();begin=performance.now();lag=monitorEventLoopDelay({resolution:10});lag.enable();process.send({type:'measuring'});};
 const rtc=transport==='rtc'?await createNativeRtcFactory({port:20000+Math.floor(Math.random()*30000)}):undefined;
 server=await createGameServer({host:'127.0.0.1',port:0,origins:[],rtc,pumpHz:60,endpoint:{bytesPerSecond:profile.rate,burstBytes:profile.burst,...(stateBudgetShare===undefined?{}:{stateBudgetShare})},
  onError:e=>errors.push(e.message),onSession:s=>{session=s;
   // Test-only observation of actual first WS sends, not enqueue attempts or received copies.
   const events=s.endpoint.events,sent=events.sent;
   events.sent=function(seq){if(cpuStart){const e=[...this.entries()].find(e=>e.seq===seq);assert.ok(e);const size=Buffer.byteLength(`{"t":"event","e":${s.endpoint.connectionEpoch},"s":${seq},"d":${e.text}}`);counters.budgetedEventBytes+=size;counters.maxEncodedEventBytes=Math.max(counters.maxEncodedEventBytes,size);}return sent.call(this,seq);};
  },
  http(req,res){if(req.url==='/measure'&&req.method==='POST'){measure();res.writeHead(200);res.end('ok');return;}res.writeHead(200,{'content-type':req.url==='/sdk.js'?'text/javascript':'text/html','cache-control':'no-store'});res.end(req.url==='/sdk.js'?bundle:browserHTML);}});
 const port=await server.listen();server.options.origins.push('http://127.0.0.1:'+port);process.send({type:'ready',port});
 process.on('message',async message=>{
  try{
   if(message.type==='start'){
    assert.ok(session?.connected);let nextState=performance.now(),nextEvent=nextState,tick=0,event=0;
    timer=setInterval(()=>{const now=performance.now();
     if(now>=nextState){nextState=now+50;const b=new Uint8Array(20),v=new DataView(b.buffer);v.setFloat64(0,now,true);v.setUint32(8,++tick,true);v.setFloat32(12,40+(tick*3)%540,true);v.setFloat32(16,160+Math.sin(tick/20)*90,true);session.sendState(1,b,{ttlMs:40});counters.statesRequested++;}
     if(profile.eventHz&&now>=nextEvent){nextEvent=now+1000/profile.eventHz;try{session.sendEvent({n:event+1,at:now,text:'x'.repeat(profile.eventBytes)});event++;counters.eventsQueued++;}catch(error){if(!/outbox|pending|full|limit|queue/i.test(error.message))throw error;counters.eventsRejected++;}}
    },5);process.send({type:'started'});
   }else if(message.type==='stop'){
    clearInterval(timer);const used=process.cpuUsage(cpuStart);lag.disable();
    const delta=key=>session.endpoint.stats[key]-startStats[key];
    const result={elapsedMs:performance.now()-begin,cpuMs:(used.user+used.system)/1000,rssMiB:process.memoryUsage().rss/1048576,eventLoopP99Ms:lag.percentile(99)/1e6,...counters,errors,endpoint:{statesSent:delta('statesSent'),expired:delta('expired'),coalesced:delta('coalesced'),encodedBytesSent:delta('bytesSent')},budgetedPrimaryBytes:counters.budgetedEventBytes+delta('statesSent')*32};
    result.packetizedBudgetBound=profile.rate*result.elapsedMs/1000+profile.burst+counters.maxEncodedEventBytes+32;
    assert.ok(result.budgetedPrimaryBytes<=result.packetizedBudgetBound,'Primary traffic must repay its configured rate with bounded oversized-packet debt');
    await server.close();process.send({type:'stopped',result},()=>process.exit(0));
   }
  }catch(error){clearInterval(timer);process.send({type:'fatal',error:error.stack});await server.close().catch(()=>{});process.exit(1);}
 });
}

async function benchmark(){
 const root=path.resolve(option('--candidate',fileURLToPath(new URL('../',import.meta.url)))),baseline=path.resolve(option('--baseline',''));
 const seconds=Number(option('--seconds',12)),repetitions=Number(option('--repetitions',5)),engine=option('--engine','chromium'),transport=option('--transport','ws'),out=path.resolve(option('--out','artifacts/browser-performance'));
 const selected=option('--profiles',transport==='ws'?'normal,mixed-budget,render-load':'normal,mixed-budget').split(',');
 const shareOption=option('--state-share',undefined),stateBudgetShare=shareOption===undefined?undefined:Number(shareOption);
 assert.ok(stateBudgetShare===undefined||Number.isFinite(stateBudgetShare)&&stateBudgetShare>0&&stateBudgetShare<1);
 assert.ok(seconds>=3&&seconds<=60&&repetitions>=1&&repetitions<=10);assert.ok(['chromium','firefox'].includes(engine));assert.ok(['ws','rtc'].includes(transport));assert.ok(selected.every(p=>Object.hasOwn(profiles,p)));
 fs.mkdirSync(out,{recursive:true});
 const {chromium,firefox}=await import(pathToFileURL(root+'/node_modules/playwright/index.mjs'));
 const version=sdk=>JSON.parse(fs.readFileSync(sdk+'/package.json')).version;
 assert.equal(version(baseline),'2.3.0');assert.notEqual(version(root),version(baseline),'Candidate must have a distinct recorded version');
 const hashes=sdk=>Object.fromEntries(['dist/browser/twinwire.js','dist/core/endpoint.js','dist/core/budget.js'].map(file=>[file,hash(fs.readFileSync(sdk+'/'+file))]));
 const report={kind:'actual-browser-canvas-sdk-comparison',captureProtocol:2,selectedProfiles:selected,at:new Date().toISOString(),source:process.env.GITHUB_SHA??null,harnessSHA256:hash(fs.readFileSync(ownFile)),seconds,repetitions,engine,transport,
  protocol:{snapshotHz:20,statePayloadBytes:20,stateTTLms:40,pumpHz:60,warmupMs:2000,profiles,capture:'Canvas pixel captures happen before rendering starts and after rendering freezes; no readbacks occur inside the timed window. Browser starts the server measurement through HTTP; window durations must agree within 250ms or 2%.',pairedOrder:'alternate baseline/candidate by repetition; fresh browser and server per sample',metrics:'JavaScript receipt age and canvas draw-submission age use synchronized server time with uncertainty. Previous submitted snapshot age is sampled before the next draw to retain frame gaps. Frame callbacks include real identical raster calls; no physical display/GPU presentation or full-game FPS claim.'},
  environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,parallelism:os.availableParallelism(),totalMemoryBytes:os.totalmem()},
  sdks:[{version:version(baseline),files:hashes(baseline)},{version:version(root),files:hashes(root)}],runs:[],limits:['Localhost sockets with an application byte budget, not OS-level packet loss, cellular or shared TCP congestion emulation.','Mixed-budget intentionally exceeds the event budget; outbox rejection and event throughput are reported.','Canvas scene frame cadence is not physical presentation or production-game FPS.','All trials, including neutral results and regressions, remain in this report.']};
 report.protocol.candidateEndpointOverrides=stateBudgetShare===undefined?{}:{stateBudgetShare};
 async function sample(sdk,profile,repetition){
  let child,browser,page,fatal;const waiters=new Map(),stdout=[];let stopped=false;
  const wait=type=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiters.delete(type);reject(Error('Timed out waiting for server '+type+' '+stdout.join('').slice(-2000)));},20000);waiters.set(type,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});});
  const row={version:version(sdk),profile,repetition,started:new Date().toISOString()};
  try{
   child=fork(ownFile,['--server','--sdk',sdk,'--profile',profile,'--transport',transport,...(sdk===root&&stateBudgetShare!==undefined?['--state-share',String(stateBudgetShare)]:[])],{stdio:['ignore','pipe','pipe','ipc']});
   child.on('message',message=>{if(message.type==='fatal'){fatal=Error(message.error);for(const waiter of waiters.values())waiter.reject(fatal);waiters.clear();}else{const waiter=waiters.get(message.type);if(waiter){waiters.delete(message.type);waiter.resolve(message);}}});
   child.on('exit',code=>{if(!stopped&&code!==0){fatal=Error('Server exited '+code);for(const waiter of waiters.values())waiter.reject(fatal);waiters.clear();}});
   for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{stdout.push(b.toString());if(stdout.length>50)stdout.shift();});
   const ready=await wait('ready');
   browser=await({chromium,firefox}[engine]).launch({headless:true,args:engine==='chromium'?['--use-angle=swiftshader','--enable-unsafe-swiftshader']:[]});row.browserVersion=browser.version();
   page=await browser.newPage({viewport:{width:800,height:600},deviceScaleFactor:1});const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
   await page.goto('http://127.0.0.1:'+ready.port);const initialPixels=await page.locator('#scene').screenshot();await page.evaluate(({transport,entities})=>B.start(transport,entities),{transport,entities:profiles[profile].entities});
   await page.waitForFunction(t=>B.client.status==='online'&&B.client.clock.synced&&B.client.clock.sampleCount>=3&&B.client.transport===t,transport,{timeout:30000});
   let pending=wait('started');child.send({type:'start'});await pending;
   await page.waitForFunction(()=>B.latest!==null);await page.waitForTimeout(2000);
   pending=wait('measuring');await page.evaluate(()=>B.begin());await pending;
   await page.waitForTimeout(seconds*1000);row.client=await page.evaluate(()=>B.finish());
   pending=wait('stopped');stopped=true;child.send({type:'stop'});row.server=(await pending).result;
   const finalPixels=await page.locator('#scene').screenshot();row.client.canvasChanged=hash(initialPixels)!==hash(finalPixels);
   assert.equal(row.client.status,'online');assert.equal(row.client.transport,transport);assert.ok(row.client.receivedStates>10);assert.ok(row.client.frameIntervalMs?.n>30);assert.ok(row.client.canvasChanged);assert.ok(row.client.drawCalls>10000);assert.ok(row.client.clockUncertaintyMs&&Number.isFinite(row.client.clockUncertaintyMs.max));
   assertCaptureWindow(row.client,row.server,transport);
   assert.ok(row.server.statesRequested>=seconds*15,'Runner must sustain at least 75% of the offered snapshot rate');
   if(profile!=='mixed-budget')assert.ok(row.client.receivedStates/row.server.statesRequested>=.9,'Uncongested control must receive at least 90% of offered states');
   assert.deepEqual(row.client.errors,[]);assert.deepEqual(pageErrors,[]);assert.deepEqual(row.server.errors,[]);assert.ok(!fatal,fatal?.message);row.valid=true;
   fs.writeFileSync(path.join(out,engine+'-'+transport+'-'+profile+'-'+row.version+'-'+repetition+'.png'),finalPixels);
   return row;
  }catch(error){row.valid=false;row.error=error.stack;fs.writeFileSync(path.join(out,'failed-'+engine+'-'+transport+'-'+profile+'-'+row.version+'-'+repetition+'.json'),JSON.stringify({...row,serverLog:stdout.join('')},null,2));throw error;}
  finally{await browser?.close();if(child&&child.exitCode===null)child.kill();}
 }
 for(const profile of selected)for(let i=0;i<repetitions;i++)for(const sdk of i%2?[root,baseline]:[baseline,root]){
  const row=await sample(sdk,profile,i);report.runs.push(row);fs.writeFileSync(path.join(out,'report-'+engine+'-'+transport+'.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({version:row.version,profile,repetition:i,engine,transport,received:row.client.receivedStates,renderAgeP95ms:row.client.renderSubmissionAgeMs.p95,fps:row.client.averageFrameCallbacksPerSecond,eventRejects:row.server.eventsRejected}));
 }
}
if(process.argv.includes('--server'))await serverProcess();else await benchmark();
