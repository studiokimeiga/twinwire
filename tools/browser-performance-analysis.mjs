import assert from 'node:assert/strict';
const median=values=>{const a=[...values].sort((x,y)=>x-y),i=Math.floor(a.length/2);return a.length%2?a[i]:(a[i-1]+a[i])/2;};
export function assertCaptureWindow(client,server,transport){
 assert.ok(Number.isFinite(client.elapsedMs)&&client.elapsedMs>0&&Number.isFinite(server.elapsedMs)&&server.elapsedMs>0);
 assert.ok(Math.abs(server.elapsedMs-client.elapsedMs)<=Math.max(250,client.elapsedMs*.02),'Browser/server measurement windows must align');
 assert.ok(client.receivedStates>0&&(client.paths[transport]??0)/client.receivedStates>=.9,'Requested path must carry at least 90% of measured application states');
}
// Predeclared engineering thresholds, not a statistical significance or universal-performance claim.
export function comparePairedRuns(pairs){
 assert.ok(Array.isArray(pairs)&&pairs.length>0);
 const pairResults=pairs.map(({before,after})=>{
  for(const row of [before,after]){assert.equal(row.valid,true);const c=row.client;assert.ok(c.renderSubmissionAgeMs.p95>0&&Number.isFinite(c.renderSubmissionAgeMs.p95));assert.ok(c.averageFrameCallbacksPerSecond>0&&Number.isFinite(c.averageFrameCallbacksPerSecond));assert.ok(c.clockUncertaintyMs.max>=0&&Number.isFinite(c.clockUncertaintyMs.max));}
  const b=before.client,a=after.client,renderAgeRatio=a.renderSubmissionAgeMs.p95/b.renderSubmissionAgeMs.p95;
  const outsideClockEstimates=a.renderSubmissionAgeMs.p95+a.clockUncertaintyMs.max<b.renderSubmissionAgeMs.p95-b.clockUncertaintyMs.max;
  const reliableCountsPresent=[a.receivedEvents,b.receivedEvents].every(n=>Number.isSafeInteger(n)&&n>=0);
  return{beforeRenderAgeP95Ms:b.renderSubmissionAgeMs.p95,afterRenderAgeP95Ms:a.renderSubmissionAgeMs.p95,renderAgeRatio,outsideClockEstimates,
   beforeReceivedEvents:b.receivedEvents??null,afterReceivedEvents:a.receivedEvents??null,reliableThroughputParity:reliableCountsPresent&&a.receivedEvents>=b.receivedEvents,
   beforeFrameCallbacksPerSecond:b.averageFrameCallbacksPerSecond,afterFrameCallbacksPerSecond:a.averageFrameCallbacksPerSecond,frameCadenceRatio:a.averageFrameCallbacksPerSecond/b.averageFrameCallbacksPerSecond};
 });
 return{pairs:pairs.length,requiredPairs:5,renderAgeP95RatioMedian:median(pairResults.map(p=>p.renderAgeRatio)),frameCadenceRatioMedian:median(pairResults.map(p=>p.frameCadenceRatio)),
  lowerLatencyDemonstrated:pairs.length>=5&&pairResults.every(p=>p.renderAgeRatio<=.9&&p.outsideClockEstimates),
  lowerLatencyWithReliableParityDemonstrated:pairs.length>=5&&pairResults.every(p=>p.renderAgeRatio<=.9&&p.outsideClockEstimates&&p.reliableThroughputParity),
  higherSceneFrameCadenceDemonstrated:pairs.length>=5&&pairResults.every(p=>p.frameCadenceRatio>=1.05),pairResults,
  interpretation:'At least five complete paired trials; every trial must improve render-submission age by at least 10% beyond reported clock estimates, or scene frame cadence by at least 5%. These are workload-specific engineering thresholds, not population confidence intervals or physical presentation/game FPS.'};
}
