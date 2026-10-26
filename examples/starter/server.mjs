// A complete authoritative game. npm install && npm start; open two tabs.
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createGameServer,createNativeRtcFactory} from 'twinwire/server';
const port=Number(process.env.PORT??8787), host=process.env.HOST??'127.0.0.1';
const players=new Map(), encoder=new TextEncoder(), decoder=new TextDecoder();
let rtc;
if(process.env.RTC==='1') rtc=await createNativeRtcFactory({port:Number(process.env.RTC_PORT??port+1)});
const files={
  '/':[new URL('./public/index.html',import.meta.url),'text/html; charset=utf-8'],
  '/game.mjs':[new URL('./public/game.mjs',import.meta.url),'text/javascript'],
  '/twinwire.mjs':[new URL('./dist/browser/twinwire.mjs',import.meta.resolve('twinwire/package.json')),'text/javascript'],
};
const allowed=process.env.ORIGINS?.split(',')??['http://127.0.0.1:'+port,'http://localhost:'+port];
export const server=await createGameServer({
  port,host,rtc,origins:allowed,resumeGraceMs:30_000,maxSessions:8,maxConnections:16,maxPerIp:16,
  onSession(session,resumed){
    if(!resumed) players.set(session.id,{id:session.id,x:40+players.size%8*40,y:100,dx:0,dy:0,at:0,score:0});
    const player=players.get(session.id);
    if(!player)return;
    session.onState=state=>{
      if(state.stream!==1||state.data.length>80)return;
      let input;try{input=JSON.parse(decoder.decode(state.data));}catch{return;}
      if(!input||!Number.isFinite(input.dx)||!Number.isFinite(input.dy))return;
      const length=Math.hypot(input.dx,input.dy);
      player.dx=input.dx/Math.max(1,length);player.dy=input.dy/Math.max(1,length);player.at=performance.now();
    };
    session.onEvent=event=>{
      if(event?.type!=='ping')return;
      // Reliable actions are ordered once per session, even across reconnects.
      player.score++;session.sendEvent({type:'pong',score:player.score});
    };
  },
  onDisconnect(session){const p=players.get(session.id);if(p){p.dx=0;p.dy=0;p.at=0;}},
  onExpire(session){players.delete(session.id);},
  async http(req,res){
    const file=files[new URL(req.url??'/','http://local').pathname];
    if(!file){res.writeHead(404);res.end();return;}
    try{const body=await readFile(fileURLToPath(file[0]));res.writeHead(200,{'content-type':file[1],'cache-control':'no-store'});res.end(body);}
    catch{res.writeHead(404);res.end();}
  },
});
let tick=0;
const timer=setInterval(()=>{
  const now=performance.now();
  for(const p of players.values()){
    const active=now-p.at<200;
    p.x=Math.max(12,Math.min(628,p.x+(active?p.dx:0)*120/60));
    p.y=Math.max(12,Math.min(308,p.y+(active?p.dy:0)*120/60));
  }
  if(++tick%3)return;
  const bytes=encoder.encode(JSON.stringify({tick,players:[...players.values()].map(({id,x,y,score})=>({id,x,y,score}))}));
  for(const s of server.sessions.values())if(s.connected)s.sendState(0,bytes);
},1000/60);
await server.listen();
console.log('Twinwire starter: http://'+host+':'+port+' (RTC '+(rtc?'enabled':'off')+')');
async function stop(){clearInterval(timer);await server.close();process.exit(0);}
process.once('SIGTERM',stop);process.once('SIGINT',stop);
