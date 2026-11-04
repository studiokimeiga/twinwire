// Deterministic scheduler/endpoint comparison. This is a model, not an HTTP/3 or cellular benchmark.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
const arg=process.argv.indexOf('--baseline');
if(arg<0||!process.argv[arg+1])throw Error('Pass --baseline /absolute/path/to/extracted/twinwire-2.3.0/package');
const roots=[path.resolve(process.argv[arg+1]),path.resolve(fileURLToPath(new URL('../',import.meta.url)))];
const percentile=(a,p)=>a.length?[...a].sort((x,y)=>x-y)[Math.max(0,Math.ceil(a.length*p)-1)]:null;
function scenario(Endpoint,readControl,profile) {
  let now=0;const wire=[];let sequence=0;
  const options={now:()=>now,bytesPerSecond:profile.rate??32768,burstBytes:profile.burst??16384};
  const a=new Endpoint(options),b=new Endpoint(options),ages=[],eventAges=[];
  let requested=0,eventsQueued=0,eventsRejected=0,lastEvent=0;
  const attach=(from,to)=>from.attach(1,{open:true,bufferedAmount:0,close(){},send(data){
    wire.push({to,data:typeof data==='string'?data:data.slice(),at:now+(profile.delayMs??0),order:sequence++});return true;}});
  attach(a,b);attach(b,a);
  b.onState=s=>ages.push(now-s.time);
  b.onEvent=(event,seq)=>{assert.equal(seq,lastEvent+1);lastEvent=seq;eventAges.push(now-event.at);};
  const deliver=()=>{let guard=0;for(;;){wire.sort((x,y)=>x.at-y.at||x.order-y.order);if(!wire.length||wire[0].at>now)break;
    assert.ok(++guard<10000);const {to,data}=wire.shift();if(typeof data==='string')to.receiveControl(readControl(data));else to.receiveBinary(data,'ws');}};
  const seconds=profile.seconds??3;
  for(let n=0;n<seconds*200;n++) {
    if(profile.states&&n%profile.states===0){requested++;a.sendState(1,new Uint8Array(profile.payload??8),now,{ttlMs:profile.ttl??100});}
    if(profile.events&&n%profile.events===0){try{a.sendEvent({at:now,text:'x'.repeat(profile.eventBytes??20)});eventsQueued++;}catch{eventsRejected++;}}
    a.pump();b.pump();deliver();now+=5;
  }
  return {name:profile.name,statesRequested:requested,statesDelivered:ages.length,deliveryFraction:requested?ages.length/requested:null,
    stateAgeP50Ms:percentile(ages,.5),stateAgeP99Ms:percentile(ages,.99),eventsQueued,eventsRejected,eventsDelivered:eventAges.length,
    eventAgeP99Ms:percentile(eventAges,.99),encodedBytes:a.stats.bytesSent,expired:a.stats.expired,coalesced:a.stats.coalesced};
}
const profiles=[{name:'state-only-50Hz',states:4,payload:96},{name:'events-only-20Hz',events:10},
  {name:'mixed-oversized-events',states:10,events:2,eventBytes:600,ttl:40,rate:4000,burst:200},
  {name:'mixed-50ms-delivery',states:10,events:2,eventBytes:600,ttl:40,rate:4000,burst:200,delayMs:50}];
const results=[];
for(const root of roots) {
  const {Endpoint}=await import(pathToFileURL(path.join(root,'dist/core/endpoint.js')));
  const {readControl}=await import(pathToFileURL(path.join(root,'dist/core/protocol.js')));
  const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  results.push({version:pkg.version,profiles:profiles.map(profile=>scenario(Endpoint,readControl,profile))});
}
assert.equal(results[0].version,'2.3.0');
for(const name of ['state-only-50Hz','events-only-20Hz']) {
  const before=results[0].profiles.find(p=>p.name===name),after=results[1].profiles.find(p=>p.name===name);
  assert.equal(after.statesDelivered,before.statesDelivered);assert.equal(after.eventsDelivered,before.eventsDelivered);
}
const before=results[0].profiles.find(p=>p.name==='mixed-oversized-events'),after=results[1].profiles.find(p=>p.name==='mixed-oversized-events');
assert.ok(after.statesDelivered>before.statesDelivered);assert.ok(after.eventsDelivered>0);assert.equal(after.eventsRejected,0);
console.log(JSON.stringify({kind:'deterministic-endpoint-model',node:process.version,stepMs:5,
  caveat:'Known identical clocks and modeled delivery delays; not browser rendering, TCP congestion, RTC, QUIC or a live game. Events remain strictly ordered; outbox rejection and throughput tradeoffs are retained.',results},null,2));
