import {GameClient} from './twinwire.mjs';
const $=id=>document.getElementById(id),canvas=$('arena'),ctx=canvas.getContext('2d');
const url=new URL('/connect',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
const key='twinwire-starter:'+url;
function forget(){try{sessionStorage.removeItem(key);}catch{}}
let checkpoint;try{checkpoint=JSON.parse(sessionStorage.getItem(key)||'null');}catch{forget();}
const options={url:url.href,room:'starter',rtc:new URLSearchParams(location.search).get('rtc')==='0'?false:undefined,...(checkpoint?{checkpoint}:{})};
let net;try{net=new GameClient(options);}catch{forget();delete options.checkpoint;net=new GameClient(options);}
let world={players:[]},resumes=0,lastVia='none',input={dx:0,dy:0};
const decoder=new TextDecoder();
const receiver=net.receiveState({stream:0,reset:()=>{world={players:[]};},apply:state=>{
  let next;try{next=JSON.parse(decoder.decode(state.data));}catch{return false;}
  if(!next||!Array.isArray(next.players)||!Number.isInteger(next.tick))return false;
  world=next;lastVia=state.via;return true;
}});
function save(){try{const cp=net.checkpoint();if(cp)sessionStorage.setItem(key,JSON.stringify(cp));}catch{/* Storage is optional; in-page recovery still works. */}}
net.onSession=info=>{if(info.resumed)resumes++;save();};
net.onEvent=event=>{if(event?.type==='pong'){$('messages').textContent='Acknowledged. Your score is '+event.score;queueMicrotask(save);}};
net.onSessionLost=info=>{forget();$('new').hidden=false;$('messages').textContent='Session ended: '+info.reason+'. Start a new session to play again.';};
net.onError=error=>{$('messages').textContent=error.message;};
net.bindPageLifecycle({unload:'pause'});addEventListener('pagehide',save);
net.connect();
$('ping').onclick=()=>{if(net.status==='online'){net.sendEvent({type:'ping'});save();}};
$('drop').onclick=()=>{net.pause();setTimeout(()=>net.connect(),2000);};
$('new').onclick=()=>{$('new').hidden=true;net.newSession();};
const keys=new Set();
function directions(){input={dx:Number(keys.has('d')||keys.has('arrowright'))-Number(keys.has('a')||keys.has('arrowleft')),dy:Number(keys.has('s')||keys.has('arrowdown'))-Number(keys.has('w')||keys.has('arrowup'))};}
addEventListener('keydown',e=>{if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)&&document.activeElement===canvas)e.preventDefault();keys.add(e.key.toLowerCase());directions();});
addEventListener('keyup',e=>{keys.delete(e.key.toLowerCase());directions();});
addEventListener('blur',()=>{keys.clear();directions();});
let start;
canvas.onpointerdown=e=>{canvas.focus();canvas.setPointerCapture(e.pointerId);start={x:e.clientX,y:e.clientY};};
canvas.onpointermove=e=>{if(!start)return;input={dx:(e.clientX-start.x)/40,dy:(e.clientY-start.y)/40};};
canvas.onpointerup=canvas.onpointercancel=()=>{start=null;input={dx:0,dy:0};};
const encode=new TextEncoder();
setInterval(()=>{if(net.status==='online')net.sendState(1,encode.encode(JSON.stringify(input)));},1000/30);
function draw(){
  ctx.clearRect(0,0,640,320);
  if(receiver.ready)for(const p of world.players){ctx.fillStyle=p.id===net.id?'#ffb454':'#919cff';ctx.beginPath();ctx.arc(p.x,p.y,10,0,Math.PI*2);ctx.fill();ctx.fillStyle='#e7e9f4';ctx.fillText(p.id.slice(0,5)+' · '+p.score,p.x+14,p.y+4);}
  $('status').textContent='Session '+(net.id??'pending')+' · '+net.status+' · '+net.transport+' · world '+(receiver.ready?'ready':'recovering')+' · resumes '+resumes;
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
// A small read-only observability surface for the accompanying integration check.
window.starter={net,receiver,get world(){return world;},get resumes(){return resumes;},get via(){return lastVia;}};
