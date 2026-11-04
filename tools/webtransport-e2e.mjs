// Real HTTP/3/WebTransport, native RTC and WS in each browser. No polyfill or fake path counts as QUIC.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { X509Certificate, createHash } from 'node:crypto';
import { chromium, firefox, webkit } from 'playwright';
import { createGameServer, createNativeRtcFactory, createWebTransportHost, createBulkHandler } from '../dist/server/index.js';
const engines = (process.env.ENGINES ?? 'chromium,firefox,webkit').split(',');
const impaired = !!process.env.IMPAIR;
const directory = await mkdtemp(path.join(os.tmpdir(), 'twinwire-wt-'));
const results = []; let server, ticker, host;
const bundle = await readFile(new URL('../dist/browser/twinwire.js', import.meta.url));
const wait = (page, fn, value, timeout = 20000) => page.waitForFunction(fn, value, { timeout, polling: 25 });
try {
  execFileSync('openssl', ['req', '-new', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-sha256', '-days', '2',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem')], { stdio: 'ignore' });
  const cert = await readFile(path.join(directory, 'cert.pem'), 'utf8'), privKey = await readFile(path.join(directory, 'key.pem'), 'utf8');
  const certificateHash = Array.from(createHash('sha256').update(new X509Certificate(cert).raw).digest());
  host = await createWebTransportHost({ url: 'https://127.0.0.1:0/twinwire', port: 0, host: '127.0.0.1', cert, privKey });
  const rtc = await createNativeRtcFactory({ port: 20000 + Math.floor(Math.random() * 30000) });
  const resource = new Uint8Array(512 * 1024).map((_, i) => i % 251);
  const resourceHash = createHash('sha256').update(resource).digest('hex');
  const bulkOrigins=[];
  const bulk = createBulkHandler({ origins: bulkOrigins, resolve: async () => {
    await new Promise(resolve=>setTimeout(resolve,500));return {bytes:resource};
  } });
  const html = `<!doctype html><meta charset="utf-8"><script src="/twinwire.js"></script><script>
  window.T = { receipts: [], events: [], rendered: null, start(hash, impaired) {
    const trace = this.trace = new Twinwire.StateTraceBuffer(4096);
    const attempts=this.wtAttempts=[];
    const note=data=>{attempts.push(data);if(attempts.length>16)attempts.shift();};
    const c = this.client = new Twinwire.GameClient({ url: 'ws://' + location.host + '/connect', room: 'wt-real',
      rtc: typeof WebTransport==='function'?false:{},
      syncPingMs: 20, webtransport: { serverCertificateHashes: [{algorithm:'sha-256',value:new Uint8Array(hash)}],create(url,options){
        const wt=new WebTransport(url,options);
        wt.ready.then(()=>note({stage:'ready',reliability:wt.reliability,maxDatagramSize:wt.datagrams.maxDatagramSize}),
          error=>note({stage:'ready-failed',name:error.name,message:error.message}));
        wt.closed.then(()=>note({stage:'closed'}),error=>note({stage:'closed-error',name:error.name,message:error.message}));return wt;
      } },
      endpoint: { trace: e => trace.record(e) }, impair: impaired ? {lagMs:30,jitterMs:10,loss:.03} : undefined });
    const timeline = new Twinwire.Timeline(), playback = new Twinwire.AdaptivePlayback(1000/30);
    const receiver = this.receiver = c.receiveState({ stream:2, playback, reset:()=>timeline.clear(), apply:state=>{
      if (state.data.length !== 12) return false;
      const data = new DataView(state.data.buffer,state.data.byteOffset,state.data.byteLength);
      const value = {position:data.getFloat32(0,true),score:data.getUint32(4,true),tick:data.getUint32(8,true)};
      this.world=value; this.receipts.push({seq:state.seq,via:state.via}); if(this.receipts.length>512)this.receipts.shift();
      if(c.clock.synced) playback.track(timeline,{time:state.time,seq:state.seq,value},c.clock.serverTime(performance.now()));
      else timeline.insert({time:state.time,seq:state.seq,value}); return true;
    }});
    let last=performance.now(); const render=now=>{const at=receiver.advance(Math.max(0,now-last));last=now;
      if(at!==null){const sample=timeline.sample(at,(a,b,t)=>({...b,position:a.position+(b.position-a.position)*t}));
        if(sample){this.rendered=sample.value;receiver.markRendered(at);}}requestAnimationFrame(render);}; requestAnimationFrame(render);
    c.onEvent = d=>this.events.push(d); c.connect();
  }, move(position) {const bytes=new Uint8Array(4);new DataView(bytes.buffer).setFloat32(0,position,true);this.client.sendState(1,bytes);this.client.flush();} };
  </script>`;
  server = await createGameServer({ origins: [], rtc, webtransport: host, allowImpairment: true,
    http(req,res) {
      if(req.url?.startsWith('/resources/')) {void bulk(req,res);return;}
      res.writeHead(200, {'content-type':req.url==='/twinwire.js'?'text/javascript':'text/html'});res.end(req.url==='/twinwire.js'?bundle:html);
    }, onSession(session,resumed) {
      if(!resumed)session.data={position:0,score:0};
      session.onState=state=>{if(state.stream===1&&state.data.length===4){const value=new DataView(state.data.buffer,state.data.byteOffset).getFloat32(0,true);
        if(Number.isFinite(value))session.data.position=Math.max(-1000,Math.min(1000,value));}};
      session.onEvent=data=>{if(data?.fire===true){session.data.score++;session.sendEvent({score:session.data.score});}};
    } });
  const origin = `http://127.0.0.1:${await server.listen()}`;
  server.options.origins.push(origin);
  bulkOrigins.push(origin);
  let tick=0; ticker=setInterval(()=>{tick++;for(const session of server.sessions.values())if(session.connected){
    const bytes=new Uint8Array(12),view=new DataView(bytes.buffer);view.setFloat32(0,session.data.position,true);view.setUint32(4,session.data.score,true);view.setUint32(8,tick,true);
    session.sendState(2,bytes);session.flush();}},1000/30);
  for(const name of engines) {
    let browser,page;const row={engine:name,impaired,kind:'actual-browser-http3-rtc-ws-localhost'};
    try {
      browser=await({chromium,firefox,webkit}[name]).launch({headless:true,args:name==='chromium'?['--no-sandbox']:[]});
      row.browser=browser.version();
      const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true});
      page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(origin);row.nativeWebTransport=await page.evaluate(()=>typeof WebTransport==='function');
      await page.evaluate(([hash,impaired])=>T.start(hash,impaired),[certificateHash,impaired]);
      row.phase='session';await wait(page,()=>T.client.status==='online'&&T.client.clock.synced);
      const id=await page.evaluate(()=>T.client.id);
      if(row.nativeWebTransport) {
        row.phase='prove-wt-application-states';
        await wait(page,()=>T.client.transport==='wt'&&T.receipts.filter(s=>s.via==='wt').length>=30);
        row.webtransportStates=await page.evaluate(()=>T.receipts.filter(s=>s.via==='wt').length);
        row.wtTiming=await page.evaluate(()=>T.trace.summary());
        assert.ok(server.sessions.get(id).endpoint.datagramProven('wt'));
      } else row.webtransportStates=0;
      row.phase='prove-backup-rtc';
      await page.evaluate(()=>{T.client.options.rtc={};});
      await wait(page,()=>T.client.endpoint.datagramProven('rtc'));
      row.phase='move-and-render';await page.evaluate(()=>{T.move(12.5);T.client.sendEvent({fire:true});});
      await wait(page,()=>T.world?.position===12.5&&T.world.score===1&&T.rendered?.position===12.5&&T.events.length===1);
      row.initialPath=await page.evaluate(()=>T.client.transport);
      // Bulk resources have their own requests and never occupy the game's reliable event sequence.
      row.phase='concurrent-bulk-and-gameplay';
      await page.evaluate(hash=>{const bulk=new Twinwire.BulkClient({maxBytes:1024*1024});T.bulkDone=false;
        T.bulkPromise=Promise.all([bulk.request(location.origin+'/resources/a',{sha256:hash}).promise,
          bulk.request(location.origin+'/resources/b',{sha256:hash}).promise]).then(()=>{T.bulkDone=true;}).finally(()=>bulk.close());
        T.client.sendEvent({fire:true});},resourceHash);
      await wait(page,()=>T.events.length===2&&T.world.score===2);
      assert.equal(await page.evaluate(()=>T.bulkDone),false,'game command must finish while independent resources are pending');
      await page.evaluate(()=>T.bulkPromise);row.bulkDidNotBlockGameplay=true;
      row.phase='rtc-fallback';
      await page.evaluate(()=>{T.client.options.webtransport=false;T.client.endpoint.dropDatagram(true,'wt');});
      await wait(page,()=>T.client.transport==='rtc'&&T.receipts.slice(-5).every(s=>s.via==='rtc'));
      row.rtcFallback=true;
      row.phase='ws-fallback';
      await page.evaluate(()=>{T.client.options.rtc=false;T.client.endpoint.dropDatagram(true,'rtc');});
      await wait(page,()=>T.client.transport==='ws'&&T.receipts.slice(-5).every(s=>s.via==='ws'));
      row.websocketFallback=true;
      row.phase='same-session-queued-action-and-render';
      await page.evaluate(()=>{T.client.pause();T.client.sendEvent({fire:true});T.client.resume();});
      await wait(page,()=>T.client.status==='online'&&T.world?.score===3&&T.events.length===3&&T.receiver.ready&&T.rendered?.score===3&&T.rendered.position===12.5);
      assert.equal(await page.evaluate(()=>T.client.id),id);
      assert.equal(await page.evaluate(()=>T.world.position),12.5);
      row.sameSession=true;row.queuedFireOnce=true;row.rendered=await page.evaluate(()=>T.rendered);
      row.diagnostics=await page.evaluate(()=>T.trace.summary());row.errors=errors;assert.deepEqual(errors,[]);
      row.phase='complete';row.pass=true;
      await page.evaluate(()=>T.client.close());
    } catch(error) {row.pass=false;row.error=error.message;process.exitCode=1;
      if(page)try{row.clientState=await page.evaluate(()=>({status:T.client.status,path:T.client.transport,
        paths:T.client.endpoint.datagramPaths,attempts:T.wtAttempts,received:T.receipts.reduce((counts,s)=>(counts[s.via]=(counts[s.via]||0)+1,counts),{})}));}catch{}
      row.serverState=server.metrics();row.serverPaths=[...server.sessions.values()].map(s=>s.endpoint.datagramPaths);
    }
    finally {await browser?.close();results.push(row);console.log(JSON.stringify(row));}
  }
} finally {
  clearInterval(ticker);if(server)await server.close();else await host?.close();
  await mkdir(new URL('../validation/',import.meta.url),{recursive:true});
  await writeFile(new URL(`../validation/webtransport${impaired?'-impaired':''}.json`,import.meta.url),JSON.stringify({node:process.version,results},null,2));
  assert.ok(directory.startsWith(path.join(os.tmpdir(),'twinwire-wt-')));await rm(directory,{recursive:true,force:true});
}
