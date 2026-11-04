import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {comparePairedRuns} from './browser-performance-analysis.mjs';
const args=process.argv.slice(2),at=args.indexOf('--out'),out=at>=0?args.splice(at,2)[1]:'artifacts/browser-performance/summary.json';
assert.ok(args.length,'Pass one or more report JSON files');
const comparisons=[],candidateVersions=new Set();
for(const file of args){const report=JSON.parse(fs.readFileSync(file));assert.equal(report.kind,'actual-browser-canvas-sdk-comparison');
 const candidateVersion=report.sdks[1].version;assert.equal(report.sdks[0].version,'2.3.0');assert.notEqual(candidateVersion,'2.3.0');candidateVersions.add(candidateVersion);
 for(const profile of Object.keys(report.protocol.profiles).filter(p=>report.runs.some(r=>r.profile===p))){
  const pairs=[];for(let i=0;i<report.repetitions;i++){
   const rows=report.runs.filter(r=>r.profile===profile&&r.repetition===i);assert.equal(rows.length,2);const before=rows.find(r=>r.version==='2.3.0'),after=rows.find(r=>r.version===candidateVersion);assert.ok(before&&after);pairs.push({before,after});
  }
  comparisons.push({engine:report.engine,transport:report.transport,profile,secondsPerTrial:report.seconds,environment:report.environment,...comparePairedRuns(pairs),
   tradeoffs:pairs.map(({before,after})=>({beforeEventsReceived:before.client.receivedEvents,afterEventsReceived:after.client.receivedEvents,beforeEventsRejected:before.server.eventsRejected,afterEventsRejected:after.server.eventsRejected,beforeEventAgeP95Ms:before.client.reliableEventAgeMs?.p95??null,afterEventAgeP95Ms:after.client.reliableEventAgeMs?.p95??null,beforeServerCpuMs:before.server.cpuMs,afterServerCpuMs:after.server.cpuMs,beforeFrameIntervalP99Ms:before.client.frameIntervalMs.p99,afterFrameIntervalP99Ms:after.client.frameIntervalMs.p99}))});
 }
}
assert.equal(candidateVersions.size,1,'Do not combine different candidate versions into one comparison');
const summary={at:new Date().toISOString(),baseline:'2.3.0',candidate:[...candidateVersions][0],comparisons,universalLatencyOrFPSClaim:false,limits:['All valid paired trials are retained, including neutral results and regressions.','Application budget overload is not physical network congestion emulation.','Render submission and frame-callback cadence do not establish physical display latency or production-game GPU FPS.']};
fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(summary,null,2)+'\n');
for(const c of comparisons)console.log(JSON.stringify({engine:c.engine,transport:c.transport,profile:c.profile,pairs:c.pairs,renderAgeRatio:c.renderAgeP95RatioMedian,frameCadenceRatio:c.frameCadenceRatioMedian,lowerLatencyDemonstrated:c.lowerLatencyDemonstrated,higherSceneFrameCadenceDemonstrated:c.higherSceneFrameCadenceDemonstrated}));
