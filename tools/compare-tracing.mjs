// Three alternating child-process repetitions, same runner and workload. Recorder remains bounded under load.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
const results=[];
for(let n=0;n<3;n++)for(const enabled of [false,true]){
  const row=JSON.parse(execFileSync(process.execPath,['tools/bench.mjs','--clients','50','--seconds','5'],
    {encoding:'utf8',env:{...process.env,TWINWIRE_TRACE:enabled?'1':'0'}}));
  assert.deepEqual(row.errors,[]);assert.equal(row.trace.enabled,enabled);
  if(enabled){assert.equal(row.trace.retained,512);assert.ok(row.trace.overwritten>0);}
  results.push({repetition:n+1,...row});
}
const median=a=>a.sort((a,b)=>a-b)[1];
const value=(enabled,key)=>median(results.filter(r=>r.trace.enabled===enabled).map(r=>r[key]));
const report={kind:'opt-in-tracing-localhost-overhead',repetitions:3,
  cpuRatio:value(true,'cpuMsIncludingClients')/value(false,'cpuMsIncludingClients'),
  deliveredStateRatio:value(true,'deliveredStates')/value(false,'deliveredStates'),
  rssRatio:value(true,'rssMB')/value(false,'rssMB'),results,
  caveat:'50 clients and server together, separate alternating processes, one hosted runner. Callback cost depends on the supplied observer. This measures a bounded 512-entry recorder, not console logging, game rendering or cellular transport.'};
console.log(JSON.stringify(report,null,2));
await writeFile(new URL('../validation/webtransport-tracing-benchmark.json',import.meta.url),JSON.stringify(report,null,2));
assert.ok(report.cpuRatio<=1.4,'Opt-in tracing CPU regression >40%');
assert.ok(report.deliveredStateRatio>=.95,'Opt-in tracing delivery regression >5%');
