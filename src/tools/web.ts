import {lookup as dnsLookup} from 'node:dns/promises';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {BlockList,isIP} from 'node:net';
import TurndownService from 'turndown';

const blocked=new BlockList();
for(const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)blocked.addSubnet(ip,bits,'ipv4');
export function publicIPv4(ip:string){return isIP(ip)===4&&!blocked.check(ip,'ipv4');}
export function webURL(input:string):URL {
  if(input.length>2048)throw new Error('Web URL exceeds 2048 characters');
  const u=new URL(input);
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port||(u.hostname.includes(':'))||u.hostname==='localhost'||u.hostname.endsWith('.localhost')||u.hostname.endsWith('.local'))throw new Error('Use credential-free public HTTP(S), standard ports and IPv4 destinations only');
  if(isIP(u.hostname)&&!publicIPv4(u.hostname))throw new Error('Non-public address blocked');
  u.hash='';return u;
}
export type Page={url:string;status:number;type:string;body:string;location?:string};
export type Transport=(url:URL,signal:AbortSignal)=>Promise<Page>;
// DNS is checked once and the chosen address is pinned to this connection. No second resolver lookup.
export async function pinnedRequest(url:URL,signal:AbortSignal,resolve=dnsLookup,sendHttp=httpRequest,sendHttps=httpsRequest):Promise<Page>{
  const addresses=await Promise.race([resolve(url.hostname,{all:true,family:4}),new Promise<never>((_,reject)=>{
    if(signal.aborted){reject(new Error('Web deadline exceeded'));return;}
    signal.addEventListener('abort',()=>reject(new Error('Web deadline exceeded')),{once:true});
  })]);
  if(!addresses.length||addresses.some(a=>!publicIPv4(a.address)))throw new Error('DNS returned a non-public or unsupported address');
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const req=(url.protocol==='https:'?sendHttps:sendHttp)(url,{
      method:'GET',signal,agent:false,headers:{'User-Agent':'PersonalAgentStarter/0.1','Accept':'text/html, text/plain, application/json','Accept-Encoding':'identity'},
      lookup:(_hostname,_options,callback)=>callback(null,addresses[0]!.address,4)
    },res=>{
      const status=res.statusCode??0,type=String(res.headers['content-type']??'').split(';')[0]!.trim().toLowerCase();
      if(status>=300&&status<400){const location=res.headers.location;res.destroy();resolve({url:url.href,status,type,body:'',location});return;}
      if(status<200||status>=300){res.destroy();reject(new Error(`Web HTTP ${status}`));return;}
      if(!['text/html','text/plain','application/json','text/markdown'].includes(type)||!['identity',''].includes(String(res.headers['content-encoding']??''))){res.destroy();reject(new Error('Unsupported web content type or encoding'));return;}
      const max=512*1024;
      if(Number(res.headers['content-length'])>max){res.destroy();reject(new Error('Web response exceeds 512 KiB'));return;}
      const chunks:Buffer[]=[];let size=0;
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>max){res.destroy(new Error('Web response exceeds 512 KiB'));return;}chunks.push(chunk);});
      res.on('error',reject);res.on('aborted',()=>reject(new Error('Web response interrupted')));
      res.on('end',()=>resolve({url:url.href,status,type,body:Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error',()=>reject(new Error('Web connection failed or deadline exceeded')));req.end();
  });
}
export class WebTools {
  constructor(private transport:Transport=pinnedRequest,private searchBase=process.env.WEB_SEARCH_URL){}
  async fetch(input:string){
    let url=webURL(input);const signal=AbortSignal.timeout(15000);
    for(let redirects=0;redirects<=3;redirects++){
      const page=await this.transport(url,signal);
      if(page.status>=300&&page.status<400){
        if(!page.location||redirects===3)throw new Error('Web redirect limit or missing destination');
        const next=webURL(new URL(page.location,url).href);
        if(url.protocol==='https:'&&next.protocol!=='https:')throw new Error('HTTPS downgrade blocked');url=next;continue;
      }
      if(page.status<200||page.status>=300)throw new Error(`Web HTTP ${page.status}`);
      let text=page.body;
      if(page.type==='text/html')text=new TurndownService({headingStyle:'atx'}).turndown(text.replace(/<(script|style|noscript|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,''));
      return {url:url.href,status:page.status,type:page.type,untrusted:true,truncated:text.length>20000,text:text.slice(0,20000)};
    }
    throw new Error('Web redirect limit');
  }
  async search(query:string){
    if(!query.trim()||query.length>500)throw new Error('Search query must be 1-500 characters');
    if(!this.searchBase)throw new Error('Configure WEB_SEARCH_URL with a public SearXNG JSON search endpoint');
    const url=webURL(this.searchBase);url.searchParams.set('q',query);url.searchParams.set('format','json');
    const page=await this.fetch(url.href);
    if(page.truncated)throw new Error('Search response too large; use a narrower query');
    const data=JSON.parse(page.text);
    if(!Array.isArray(data.results))throw new Error('Search endpoint returned no results array');
    return {url:page.url,untrusted:true,results:data.results.slice(0,8).flatMap((r:any)=>{
      if(typeof r?.url!=='string'||typeof r?.title!=='string')return [];
      try{return [{url:webURL(r.url).href,title:r.title.slice(0,200),snippet:typeof r.content==='string'?r.content.slice(0,800):''}];}catch{return [];}
    })};
  }
}
