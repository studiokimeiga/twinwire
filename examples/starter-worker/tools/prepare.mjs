
import fs from 'node:fs/promises';
const out=new URL('../public/',import.meta.url),source=new URL('../../starter/public/',import.meta.url);
await fs.mkdir(out,{recursive:true});
let html=await fs.readFile(new URL('index.html',source),'utf8');
html=html.replace('This demo uses a real server. Add <code>?rtc=0</code> to test WebSocket only. To try WebRTC, restart the server with <code>RTC=1 npm start</code>.','This hosted arena uses Twinwire over WebSocket in a Durable Object. Each invite has its own room for up to eight players. Reconnect within 30 seconds to keep your seat; a server restart creates a new arena. The downloadable Node starter also supports native WebRTC.');
html=html.replace('<script type="module"', '<script>const invite=new URL(location.href);if(!invite.searchParams.has("room")){invite.searchParams.set("room",crypto.randomUUID());history.replaceState(null,"",invite);}</script><script type="module"');
await fs.writeFile(new URL('index.html',out),html);
let game=await fs.readFile(new URL('game.mjs',source),'utf8');
game=game.replace("const key='twinwire-starter:'+url;", "url.searchParams.set('room',new URLSearchParams(location.search).get('room'));\nconst key='twinwire-starter:'+url;");
await fs.writeFile(new URL('game.mjs',out),game);
await fs.copyFile(new URL('./dist/browser/twinwire.mjs',import.meta.resolve('twinwire/package.json')),new URL('twinwire.mjs',out));
console.log('Prepared complete Worker client from the same starter and installed SDK.');
