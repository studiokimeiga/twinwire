import test from 'node:test';
import assert from 'node:assert/strict';
import {comparePairedRuns} from '../tools/browser-performance-analysis.mjs';
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
