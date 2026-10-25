// Release gate. Missing native dependencies are a failure, never a passing fallback test.
import { createGameServer, createNativeRtcFactory } from '../dist/server/index.js';
import { GameClient } from '../dist/client/index.js';
const { RTCPeerConnection } = await import('node-datachannel/polyfill');
globalThis.RTCPeerConnection = RTCPeerConnection;
const wait=async fn=>{const end=performance.now()+15000;while(!fn()){if(performance.now()>end)throw new Error('Native RTC gate timed out');await new Promise(r=>setTimeout(r,20));}};
const rtc=await createNativeRtcFactory({port:8788});let peer;const got=[];
const server=await createGameServer({origins:[],allowMissingOrigin:true,rtc,onError:e=>console.error(e),onSession:s=>{peer=s;s.onState=m=>{s.sendState(m.stream,m.data);s.endpoint.flush();};}});
const port=await server.listen(),client=new GameClient({url:`ws://127.0.0.1:${port}/connect`,room:'native-test',rtcRetryMs:1200});
client.onState=s=>got.push(s);client.onError=e=>console.error(e.message);
try {
 client.connect();await wait(()=>client.endpoint.fastActive&&peer?.endpoint.fastActive&&client.clock.synced);
 client.sendState(1,Uint8Array.of(7));client.flush();await wait(()=>got.length);if(got[0].via!=='rtc')throw new Error('Unexpected WebSocket fallback');
 const id=client.id;client.endpoint.dropDatagram();await wait(()=>!peer.endpoint.fastActive);
 client.sendState(1,Uint8Array.of(9));client.flush();await wait(()=>got.some(s=>s.data[0]===9&&s.via==='ws'));
 await wait(()=>client.endpoint.fastActive&&peer.endpoint.fastActive);if(client.id!==id)throw new Error('Session changed on transport retry');
 console.log(JSON.stringify({nativeRtc:true,fallback:true,recovery:true,sameSession:true},null,2));
} finally {client.close();await server.close();}
