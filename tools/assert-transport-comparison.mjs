import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const directory=process.argv[2];if(!directory)throw Error('Pass benchmark artifact directory');
const values={baseline:[],candidate:[]};
for(const kind of Object.keys(values))for(let n=1;n<=3;n++)values[kind].push(JSON.parse(await readFile(path.join(directory,`${kind}-${n}.json`),'utf8')));
const median=(kind,key)=>values[kind].map(row=>row[key]).sort((a,b)=>a-b)[1];
for(const row of [...values.baseline,...values.candidate]){assert.deepEqual(row.errors,[]);assert.ok(row.deliveredStates>0);assert.equal(row.clients,50);}
const result={kind:'alternating-same-runner-localhost-websocket-comparison',repetitions:3,
  baselineVersion:values.baseline[0].sdkVersion,candidateVersion:values.candidate[0].sdkVersion,
  deliveredStateRatio:median('candidate','deliveredStates')/median('baseline','deliveredStates'),
  cpuRatio:median('candidate','cpuMsIncludingClients')/median('baseline','cpuMsIncludingClients'),
  rssRatio:median('candidate','rssMB')/median('baseline','rssMB'),
  eventLoopP99Ms:median('candidate','eventLoopP99Ms'),
  caveat:'Separate processes on one hosted runner, 50 local clients and server together; not a device/cellular/game-frame or QUIC comparison. Noise remains; raw repetitions are retained.'};
await writeFile(path.join(directory,'localhost-summary.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
assert.equal(result.baselineVersion,'2.3.0');assert.ok(result.deliveredStateRatio>=.95,'delivered state regression');
assert.ok(result.cpuRatio<=1.25,'CPU regression >25% requires investigation');
assert.ok(result.eventLoopP99Ms<50,'event-loop p99 exceeds 50ms');
