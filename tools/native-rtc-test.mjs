// Release gate. Missing native dependencies are a failure, never a passing fallback test.
import { createGameServer, createNativeRtcFactory } from '../dist/server/index.js';
import { GameClient } from '../dist/client/index.js';
const { RTCPeerConnection } = await import('node-datachannel/polyfill');
globalThis.RTCPeerConnection = RTCPeerConnection;
const wait=async fn=>{const end=performance.now()+15000;while(!fn()){if(performance.now()>end)throw new Error('Native RTC gate timed out');await new Promise(r=>setTimeout(r,20));}};
const native=await createNativeRtcFactory({port:8788}),offers=[];
const rtc=cb=>{const p=native(cb);return{close:()=>p.close(),signal:m=>{if(m.kind==='offer')offers.push(performance.now());return p.signal(m);}};};let peer;const got=[];
const server=await createGameServer({origins:[],allowMissingOrigin:true,rtc,onError:e=>console.error(e),onSession:s=>{peer=s;s.onState=m=>{s.sendState(m.stream,m.data);s.endpoint.flush();};}});
const retryBaseMs=250,offerBudgetMs=750;
const port=await server.listen(),client=new GameClient({url:`ws://127.0.0.1:${port}/connect`,room:'native-test',rtcRetryMs:retryBaseMs});
client.onState=s=>got.push(s);client.onError=e=>console.error(e.message);
try {
 client.connect();await wait(()=>client.endpoint.fastActive&&peer?.endpoint.fastActive&&client.clock.synced);
 client.sendState(1,Uint8Array.of(7));client.flush();await wait(()=>got.length);if(got[0].via!=='rtc')throw new Error('Unexpected WebSocket fallback');
 const id=client.id,retries=[];
 for(let i=0;i<3;i++){
  // The server deliberately accepts at most one RTC offer per second. Keep each proven path healthy beyond that
  // cooldown before inducing the next outage; this gate measures retry debt, not offer-rate limiting.
  await new Promise(r=>setTimeout(r,1100));
  const n=offers.length,at=performance.now();client.endpoint.dropDatagram();await wait(()=>!peer.endpoint.fastActive);
  // A valid reset for an already-stopped attempt can race the local close. Duplicate controls must not add retry debt.
  if(i===0)for(let j=0;j<2;j++)peer.endpoint.sendControl({t:'rtc-reset',e:peer.epoch,a:client.rtcAttempt});
  client.sendState(1,Uint8Array.of(9+i));client.flush();await wait(()=>got.some(s=>s.data[0]===9+i&&s.via==='ws'));
  await wait(()=>offers.length>n);const offerAfterMs=offers[n]-at;
  if(offerAfterMs>offerBudgetMs)throw Error(`RTC retry ${i+1} took ${offerAfterMs.toFixed(1)}ms (base${retryBaseMs}, budget${offerBudgetMs}); successful proof must reset retry debt`);
  await wait(()=>client.endpoint.fastActive&&peer.endpoint.fastActive);if(client.id!==id)throw new Error('Session changed on transport retry');
  retries.push({attempt:i+1,offerAfterMs});
 }
 console.log(JSON.stringify({nativeRtc:true,fallback:true,recovery:true,sameSession:true,retryBaseMs,offerBudgetMs,retries},null,2));
} finally {client.close();await server.close();}
