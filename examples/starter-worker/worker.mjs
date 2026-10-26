
import {SocketSessionServer} from 'twinwire/worker';
const encoder=new TextEncoder(),decoder=new TextDecoder();
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/health')return Response.json({ok:true,twinwire:'2.2.0',wire:4,transport:'ws',example:'starter-worker'});
    if(url.pathname!=='/connect')return env.ASSETS.fetch(request);
    const room=url.searchParams.get('room');
    if(!room||!/^[a-zA-Z0-9-]{8,40}$/.test(room))return new Response('Invalid room',{status:400});
    return env.ARENA.get(env.ARENA.idFromName(room)).fetch(request);
  },
};
export class ArenaRoom {
  constructor(){
    this.players=new Map();this.tick=0;
    this.host=new SocketSessionServer({
      origins:['https://twinwire-demo.hak7alp.workers.dev','http://127.0.0.1:8789','http://localhost:8789'],
      maxSessions:8,maxConnections:16,maxPerIp:16,resumeGraceMs:30_000,
      onError:error=>console.error('Starter transport:',error.message),
      authenticate:({room})=>room==='starter'?'public-invite-room':null,
      onSession:(session,resumed)=>{
        if(!resumed)this.players.set(session.id,{id:session.id,x:40+this.players.size%8*40,y:100,dx:0,dy:0,at:0,score:0});
        const player=this.players.get(session.id);if(!player)return;
        session.onState=state=>{
          if(state.stream!==1||state.data.length>80)return;
          let input;try{input=JSON.parse(decoder.decode(state.data));}catch{return;}
          if(!input||!Number.isFinite(input.dx)||!Number.isFinite(input.dy))return;
          const length=Math.max(1,Math.hypot(input.dx,input.dy));
          player.dx=input.dx/length;player.dy=input.dy/length;player.at=performance.now();
        };
        session.onEvent=event=>{if(event?.type==='ping'){player.score++;session.sendEvent({type:'pong',score:player.score});}};
        this.timer??=setInterval(()=>this.step(),1000/60);
      },
      onDisconnect:session=>{const p=this.players.get(session.id);if(p){p.dx=p.dy=p.at=0;}},
      onExpire:session=>{this.players.delete(session.id);if(!this.players.size){clearInterval(this.timer);this.timer=undefined;}},
    });
  }
  async fetch(request){
    const origin=request.headers.get('Origin')||'';
    if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('WebSocket required',{status:426});
    if(!this.host.allowsOrigin(origin))return new Response('Origin rejected',{status:403});
    const pair=new WebSocketPair();pair[1].binaryType='arraybuffer';pair[1].accept();
    this.host.accept(pair[1],{origin,ip:request.headers.get('CF-Connecting-IP')||'local'});
    return new Response(null,{status:101,webSocket:pair[0]});
  }
  step(){
    const now=performance.now();
    for(const p of this.players.values()){
      const active=now-p.at<200;p.x=Math.max(12,Math.min(628,p.x+(active?p.dx:0)*120/60));p.y=Math.max(12,Math.min(308,p.y+(active?p.dy:0)*120/60));
    }
    if(++this.tick%3)return;
    const bytes=encoder.encode(JSON.stringify({tick:this.tick,players:[...this.players.values()].map(({id,x,y,score})=>({id,x,y,score}))}));
    for(const session of this.host.sessions.values())if(session.connected)session.sendState(0,bytes);
  }
}
