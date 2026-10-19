import {createHmac,timingSafeEqual} from 'node:crypto';
import {createServer,type IncomingMessage} from 'node:http';
import type {RuntimeStore} from './store.js';
function equal(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export type BotConfig={telegramSecret?:string;telegramUsers:string[];telegramChats:string[];slackSecret?:string;slackUsers:string[];slackChannels:string[];slackTeam?:string};
export function receiveBot(store:RuntimeStore,config:BotConfig,path:string,headers:Record<string,string>,raw:string,now=Date.now()){
  if(path==='/telegram'){
    if(!config.telegramSecret||!equal(headers['x-telegram-bot-api-secret-token']??'',config.telegramSecret))throw new Error('Unauthorized');
    const update=JSON.parse(raw),m=update.message;
    if(!Number.isSafeInteger(update.update_id)||!m?.from||m.from.is_bot||!config.telegramUsers.includes(String(m.from.id))||!config.telegramChats.includes(String(m.chat?.id))||typeof m.text!=='string')throw new Error('Unauthorized');
    return {task:store.ingest('telegram',String(update.update_id),m.text)};
  }
  if(path==='/slack'){
    const timestamp=headers['x-slack-request-timestamp']??'';
    if(!config.slackSecret||!/^\d+$/.test(timestamp)||Math.abs(now/1000-Number(timestamp))>300)throw new Error('Unauthorized');
    const expected='v0='+createHmac('sha256',config.slackSecret).update('v0:'+timestamp+':'+raw).digest('hex');
    if(!equal(headers['x-slack-signature']??'',expected))throw new Error('Unauthorized');
    const data=JSON.parse(raw);if(!config.slackTeam||data.team_id!==config.slackTeam)throw new Error('Unauthorized');
    if(data.type==='url_verification'&&typeof data.challenge==='string')return {challenge:data.challenge};
    const e=data.event;
    if(data.type!=='event_callback'||typeof data.event_id!=='string'||!e||!['app_mention','message'].includes(e.type)||e.bot_id||e.subtype||!config.slackUsers.includes(e.user)||!config.slackChannels.includes(e.channel)||typeof e.text!=='string')throw new Error('Unauthorized');
    return {task:store.ingest('slack',data.event_id,e.text)};
  }
  throw new Error('Unknown route');
}
async function body(req:IncomingMessage){let data='';for await(const chunk of req){data+=chunk.toString();if(Buffer.byteLength(data)>65536)throw new Error('Too large');}return data;}
export function botServer(store:RuntimeStore,config:BotConfig,port=8788){
  const server=createServer(async(req,res)=>{try{
    if(req.method!=='POST'){res.writeHead(405).end();return;}
    const raw=await body(req),headers=Object.fromEntries(Object.entries(req.headers).map(([k,v])=>[k,Array.isArray(v)?v[0]??'':v??'']));
    const result=receiveBot(store,config,req.url??'',headers,raw);res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(result));
  }catch{res.writeHead(403).end('Rejected');}});
  server.requestTimeout=10000;server.headersTimeout=10000;
  return new Promise<ReturnType<typeof createServer>>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve(server));});
}
// Explicit helpers, not model-callable tools. Sending needs separate owner review.
export async function sendTelegram(token:string,chatId:string,text:string){const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text}),signal:AbortSignal.timeout(15000)});if(!r.ok||(await r.json() as any).ok!==true)throw new Error('Telegram send failed');}
export async function sendSlack(token:string,channel:string,text:string){const r=await fetch('https://slack.com/api/chat.postMessage',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({channel,text}),signal:AbortSignal.timeout(15000)});if(!r.ok||(await r.json() as any).ok!==true)throw new Error('Slack send failed');}
