import assert from 'node:assert/strict';
const median=values=>{const a=[...values].sort((x,y)=>x-y),i=Math.floor(a.length/2);return a.length%2?a[i]:(a[i-1]+a[i])/2;};
// Predeclared engineering thresholds, not a statistical significance or universal-performance claim.
export function comparePairedRuns(pairs){
 assert.ok(Array.isArray(pairs)&&pairs.length>0);
 const pairResults=pairs.map(({before,after})=>{
  for(const row of [before,after]){assert.equal(row.valid,true);const c=row.client;assert.ok(c.renderSubmissionAgeMs.p95>0&&Number.isFinite(c.renderSubmissionAgeMs.p95));assert.ok(c.averageFrameCallbacksPerSecond>0&&Number.isFinite(c.averageFrameCallbacksPerSecond));assert.ok(c.clockUncertaintyMs.max>=0&&Number.isFinite(c.clockUncertaintyMs.max));}
  const b=before.client,a=after.client,renderAgeRatio=a.renderSubmissionAgeMs.p95/b.renderSubmissionAgeMs.p95;
  const outsideClockEstimates=a.renderSubmissionAgeMs.p95+a.clockUncertaintyMs.max<b.renderSubmissionAgeMs.p95-b.clockUncertaintyMs.max;
  return{beforeRenderAgeP95Ms:b.renderSubmissionAgeMs.p95,afterRenderAgeP95Ms:a.renderSubmissionAgeMs.p95,renderAgeRatio,outsideClockEstimates,
   beforeFrameCallbacksPerSecond:b.averageFrameCallbacksPerSecond,afterFrameCallbacksPerSecond:a.averageFrameCallbacksPerSecond,frameCadenceRatio:a.averageFrameCallbacksPerSecond/b.averageFrameCallbacksPerSecond};
 });
 return{pairs:pairs.length,requiredPairs:5,renderAgeP95RatioMedian:median(pairResults.map(p=>p.renderAgeRatio)),frameCadenceRatioMedian:median(pairResults.map(p=>p.frameCadenceRatio)),
  lowerLatencyDemonstrated:pairs.length>=5&&pairResults.every(p=>p.renderAgeRatio<=.9&&p.outsideClockEstimates),
  higherSceneFrameCadenceDemonstrated:pairs.length>=5&&pairResults.every(p=>p.frameCadenceRatio>=1.05),pairResults,
  interpretation:'At least five complete paired trials; every trial must improve render-submission age by at least 10% beyond reported clock estimates, or scene frame cadence by at least 5%. These are workload-specific engineering thresholds, not population confidence intervals or physical presentation/game FPS.'};
}
