// Real two-browser starter acceptance. Run a matching host first; set STARTER_URL and STARTER_WIRE.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
const base=process.env.STARTER_URL||'http://127.0.0.1:8787/?room=starter-regression-'+Date.now(),out=path.resolve('artifacts/starter',process.env.STARTER_LABEL??(base.includes('workers.dev')?'live':'local'));await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});const errors=[],frames=[],opened=[];let stage='load';
try{
 const contexts=[await browser.newContext(),await browser.newContext()],pages=await Promise.all(contexts.map(c=>c.newPage()));
 opened.push(...pages);
 for(const page of pages){page.on('pageerror',e=>errors.push(e.message));page.on('websocket',s=>{s.on('framereceived',f=>{if(typeof f.payload==='string'){try{const m=JSON.parse(f.payload);if(m.t!=='pong')frames.push({t:m.t,reason:m.reason});}catch{}}});s.on('close',()=>frames.push({t:'socket-closed'}));});await page.goto(base);}
 const [a,b]=pages;
 for(const p of pages)await p.waitForFunction(()=>window.starter?.net.status==='online'&&window.starter.receiver.ready,null,{timeout:15000});
 const peerIds=await Promise.all(pages.map(p=>p.evaluate(()=>starter.net.id)));assert.notEqual(peerIds[0],peerIds[1]);
 for(const p of pages)await p.waitForFunction(ids=>ids.every(id=>starter.world.players.some(player=>player.id===id)),peerIds);
 if(process.env.STARTER_WIRE)for(const p of pages)await p.waitForFunction(wire=>starter.net.transport===wire&&starter.via===wire,process.env.STARTER_WIRE,{timeout:20000});
 stage='movement';const initial=await a.evaluate(()=>({id:starter.net.id,p:starter.world.players.find(p=>p.id===starter.net.id)}));
 await a.locator('#arena').focus();await a.keyboard.down('d');await a.waitForTimeout(350);await a.keyboard.up('d');
 await b.waitForFunction(({id,x})=>starter.world.players.find(p=>p.id===id)?.x>x+10,{id:initial.id,x:initial.p.x});
 stage='ping';await a.locator('#ping').click();await a.waitForFunction(()=>starter.world.players.find(p=>p.id===starter.net.id)?.score===1);
 stage='pause';await a.locator('#drop').click();await a.waitForFunction(()=>starter.net.status==='paused'&&!starter.receiver.ready);
 await a.evaluate(()=>starter.net.sendEvent({type:'ping'}));
 await a.waitForFunction(()=>starter.resumes===1&&starter.receiver.ready&&starter.world.players.find(p=>p.id===starter.net.id)?.score===2,null,{timeout:15000});
 if(process.env.STARTER_WIRE)await a.waitForFunction(wire=>starter.net.transport===wire&&starter.via===wire,process.env.STARTER_WIRE,{timeout:20000});
 assert.equal(await a.evaluate(()=>starter.net.id),initial.id);
 stage='reload';await a.reload();await a.waitForFunction(()=>window.starter&&starter.net.status==='online'&&starter.receiver.ready&&starter.world.players.find(p=>p.id===starter.net.id)?.score===2,null,{timeout:15000});
 if(process.env.STARTER_WIRE)await a.waitForFunction(wire=>starter.net.transport===wire&&starter.via===wire,process.env.STARTER_WIRE,{timeout:20000});
 assert.equal(await a.evaluate(()=>starter.net.id),initial.id);
 const receipt=await a.evaluate(()=>({id:starter.net.id,status:starter.net.status,transport:starter.net.transport,via:starter.via,players:starter.world.players.length,score:starter.world.players.find(p=>p.id===starter.net.id)?.score}));
 stage='bounded timing';
 assert.equal(await a.evaluate(()=>starter.timing),null,'tracing is disabled by default');
 await a.locator('#timing-panel summary').click();
 const enabled=new URL(await a.locator('#timing-toggle').getAttribute('href'));
 assert.equal(enabled.searchParams.get('room'),new URL(a.url()).searchParams.get('room'),'timing preserves the private invite');
 await a.locator('#timing-toggle').click();
 await a.waitForFunction(id=>window.starter&&starter.net.id===id&&starter.receiver.ready&&starter.world.players.find(p=>p.id===id)?.score===2,initial.id);
 await a.waitForFunction(()=>starter.timing?.overwritten>0&&starter.timing?.renderAgeMs?.count>0&&starter.timing?.receiveAgeMs?.count>0,null,{timeout:15000});
 const timing=await a.evaluate(()=>starter.timing);assert.equal(timing.retained,512);assert.ok(Number.isFinite(timing.renderAgeMs.p50));assert.ok(Number.isFinite(timing.receiveAgeMs.p50));
 await a.locator('#timing-toggle').click();
 await a.waitForFunction(id=>window.starter&&starter.net.id===id&&starter.receiver.ready&&starter.world.players.find(p=>p.id===id)?.score===2&&starter.timing===null,initial.id);
 assert.deepEqual(errors,[]);await a.screenshot({path:path.join(out,'reconnected.png'),fullPage:true});
 await fs.writeFile(path.join(out,'receipt.json'),JSON.stringify({ok:true,url:base,...receipt,movement:true,queuedPing:'once',checkpointReload:true,boundedTiming:timing,timingToggleRetainedIdentity:true,errors},null,2));console.log(JSON.stringify({ok:true,...receipt,movement:true,queuedPing:'once',checkpointReload:true}));
}catch(error){console.error(JSON.stringify({stage,error:error.message,errors,frames:frames.slice(-20),states:await Promise.all(opened.map(p=>p.evaluate(()=>({status:window.starter?.net.status,messages:document.getElementById('messages')?.textContent,ready:window.starter?.receiver.ready,players:window.starter?.world.players.length}))))}));throw error;}
finally{await browser.close();}
