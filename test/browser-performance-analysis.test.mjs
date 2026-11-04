import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {comparePairedRuns,assertCaptureWindow} from '../tools/browser-performance-analysis.mjs';
const run=(age,fps=60,uncertainty=1)=>({valid:true,client:{renderSubmissionAgeMs:{p95:age},clockUncertaintyMs:{max:uncertainty},averageFrameCallbacksPerSecond:fps}});
const pairs=(before,after,n=5)=>Array.from({length:n},()=>({before,after}));
test('an apparent latency gain inside clock uncertainty is retained but not advertised',()=>{
 const r=comparePairedRuns(pairs(run(50,60,15),run(40,60,15)));
 assert.equal(r.lowerLatencyDemonstrated,false);assert.equal(r.renderAgeP95RatioMedian,.8);assert.equal(r.higherSceneFrameCadenceDemonstrated,false);
});
test('a repeated latency improvement exceeding reported clock uncertainty qualifies only for these paired trials',()=>{
 const r=comparePairedRuns(pairs(run(150),run(55)));
 assert.equal(r.lowerLatencyDemonstrated,true);assert.equal(r.pairs,5);assert.equal(r.higherSceneFrameCadenceDemonstrated,false);
});
test('one FPS regression prevents a consistent gain claim even when the median improves',()=>{
 const trials=pairs(run(100,40),run(80,48));trials[4]={before:run(100,40),after:run(80,38)};
 const r=comparePairedRuns(trials);assert.equal(r.frameCadenceRatioMedian,1.2);assert.equal(r.higherSceneFrameCadenceDemonstrated,false);assert.equal(r.pairResults.length,5);
});
test('a single pilot sample cannot produce a demonstrated improvement claim',()=>{
 const r=comparePairedRuns(pairs(run(150,30),run(50,60),1));assert.equal(r.lowerLatencyDemonstrated,false);assert.equal(r.higherSceneFrameCadenceDemonstrated,false);
});
test('missing clock estimates and failed samples cannot enter a passing comparison',()=>{
 assert.throws(()=>comparePairedRuns(pairs(run(50),run(20,60,Infinity))));
 assert.throws(()=>comparePairedRuns(pairs(run(50),{...run(20),valid:false})));
});
test('the observed Chromium 34-second server and 12-second browser windows are invalid',()=>{
 assert.throws(()=>assertCaptureWindow({elapsedMs:12217.2,receivedStates:396,paths:{ws:396}},{elapsedMs:33701.86},'ws'),/windows must align/);
});
test('a final RTC label cannot substitute for actual measured RTC application states',()=>{
 assert.throws(()=>assertCaptureWindow({elapsedMs:12217.5,receivedStates:376,paths:{rtc:177,ws:199}},{elapsedMs:12220},'rtc'),/Requested path/);
});
test('aligned windows with the requested application path remain valid',()=>{
 assertCaptureWindow({elapsedMs:12001,receivedStates:235,paths:{rtc:235}},{elapsedMs:12007},'rtc');
});
test('lower latency cannot qualify as reliable-throughput parity when one trial delivers fewer events',()=>{
 const before=run(150),after=run(100);before.client.receivedEvents=65;after.client.receivedEvents=65;
 const trials=pairs(before,after);trials[4]={before,after:{...after,client:{...after.client,receivedEvents:64}}};
 const r=comparePairedRuns(trials);
 assert.equal(r.lowerLatencyDemonstrated,true);
 assert.equal(r.lowerLatencyWithReliableParityDemonstrated,false);
});
test('reliable parity needs complete counts and five passing latency pairs',()=>{
 const before=run(150),after=run(100);before.client.receivedEvents=65;after.client.receivedEvents=66;
 assert.equal(comparePairedRuns(pairs(before,after)).lowerLatencyWithReliableParityDemonstrated,true);
 assert.equal(comparePairedRuns(pairs(before,after,1)).lowerLatencyWithReliableParityDemonstrated,false);
 assert.equal(comparePairedRuns(pairs(run(150),run(100))).lowerLatencyWithReliableParityDemonstrated,false);
});
test('the summary uses the recorded candidate version rather than silently assuming 3.0.0',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'twinwire-summary-'));
 try{
  const rows=[];for(let i=0;i<5;i++)for(const [version,age,receivedEvents] of [['2.3.0',150,65],['3.0.1',100,66]]){
   const row=run(age);Object.assign(row,{version,profile:'mixed-budget',repetition:i,server:{eventsRejected:0,cpuMs:1}});Object.assign(row.client,{receivedEvents,frameIntervalMs:{p99:17}});rows.push(row);
  }
  const file=path.join(dir,'report.json'),out=path.join(dir,'summary.json');
  fs.writeFileSync(file,JSON.stringify({kind:'actual-browser-canvas-sdk-comparison',sdks:[{version:'2.3.0'},{version:'3.0.1'}],protocol:{profiles:{'mixed-budget':{}}},repetitions:5,runs:rows}));
  const child=spawnSync(process.execPath,['tools/summarize-browser-performance.mjs',file,'--out',out],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  const result=JSON.parse(fs.readFileSync(out));assert.equal(result.candidate,'3.0.1');assert.equal(result.comparisons[0].lowerLatencyWithReliableParityDemonstrated,true);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
