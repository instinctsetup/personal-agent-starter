import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WebTools,webURL,publicIPv4,pinnedRequest,type Transport} from '../src/tools/web.js';
import {Memory} from '../src/memory/db.js';
import {registry} from '../src/tools/registry.js';
import {AgentLoop} from '../src/agent/loop.js';
import {RuntimeStore} from '../src/runtime/store.js';
test('web URL rejects local, private, alternate encodings, IPv6, ports and credentials',()=>{
 for(const url of ['http://localhost','http://a.local','http://127.1','http://2130706433','http://0x7f000001','http://10.0.0.1','http://172.16.0.1','http://192.168.1.1','http://169.254.169.254','http://100.64.0.1','http://[::1]','http://[::ffff:127.0.0.1]','https://example.com:444','https://user:pass@example.com','file:///etc/passwd','ftp://example.com'])assert.throws(()=>webURL(url),url);
 for(const ip of ['0.1.2.3','198.18.1.1','192.0.2.1','224.1.1.1','240.0.0.1','::1'])assert.equal(publicIPv4(ip),false);
 assert.equal(publicIPv4('93.184.216.34'),true);assert.equal(webURL('https://example.com/a#b').href,'https://example.com/a');
});
test('DNS rejects mixed public/private answers before any socket opens',async()=>{
 const resolver=async()=>[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}];
 await assert.rejects(pinnedRequest(new URL('https://example.com'),AbortSignal.timeout(1000),resolver as any),/non-public/);
});
test('web converts HTML, strips active content and bounds model output',async()=>{
 const web=new WebTools(async(u,s)=>{assert.ok(s);return {url:u.href,status:200,type:'text/html',body:'<h1>Hello</h1><script>bad()</script><p>World</p>'};});
 const result=await web.fetch('https://example.com');assert.match(result.text,/# Hello/);assert.ok(!result.text.includes('bad()'));assert.equal(result.untrusted,true);
 const large=new WebTools(async u=>({url:u.href,status:200,type:'text/plain',body:'a'.repeat(21000)}));assert.equal((await large.fetch('https://example.com')).text.length,20000);assert.equal((await large.fetch('https://example.com')).truncated,true);
});
test('every redirect is validated, downgrade and loops fail, no cookies forwarded',async()=>{
 let calls=0;const redirect:Transport=async u=>{calls++;return {url:u.href,status:302,type:'',body:'',location:'http://169.254.169.254/latest'};};
 await assert.rejects(new WebTools(redirect).fetch('https://example.com'));assert.equal(calls,1);
 await assert.rejects(new WebTools(async u=>({url:u.href,status:302,type:'',body:'',location:'http://example.com'})).fetch('https://example.com'),/downgrade/);
 calls=0;await assert.rejects(new WebTools(async u=>{calls++;return {url:u.href,status:302,type:'',body:'',location:'/again'};}).fetch('https://example.com'),/redirect/);assert.equal(calls,4);
});
test('network errors and timeouts propagate, HTTP failures are not content',async()=>{
 await assert.rejects(new WebTools(async()=>{throw new Error('timeout');}).fetch('https://example.com'),/timeout/);
 await assert.rejects(new WebTools(async u=>({url:u.href,status:403,type:'text/html',body:'denied'})).fetch('https://example.com'),/403/);
});
test('configured search encodes query, bounds results and filters unsafe URLs',async()=>{
 const web=new WebTools(async u=>{assert.equal(u.searchParams.get('q'),'a & b');assert.equal(u.searchParams.get('format'),'json');return {url:u.href,status:200,type:'application/json',body:JSON.stringify({results:[{url:'https://example.com/a',title:'A',content:'B'},{url:'http://127.0.0.1',title:'bad'}]})};},'https://search.example/search');
 const result=await web.search('a & b');assert.equal(result.results.length,1);assert.equal(result.results[0]?.title,'A');
 await assert.rejects(new WebTools().search('hello'),/WEB_SEARCH_URL/);
});
test('web tools cannot execute or auto-approve without exact owner review',async()=>{
 const memory=new Memory(':memory:'),id=memory.create('read public web'),{tools,browser}=registry(async()=>{},memory);
 let calls=0;tools.web_fetch!.run=async()=>{calls++;return 'ok';};
 const loop=new AgentLoop(memory,{complete:async()=>JSON.stringify({type:'tool',tool:'web_fetch',args:{url:'https://example.com'},reason:'read'})},tools,async()=>false);
 await loop.run(id);assert.equal(calls,0);
 const store=new RuntimeStore(memory);assert.equal(store.approve(id,'web_fetch',{url:'https://example.com'},[{tool:'web_fetch',args:{url:'https://example.com'}}]),false);
 await browser.close();memory.close();
});
test('history window stays ordered and bounded without losing stored events',()=>{
 const memory=new Memory(':memory:'),id=memory.create('original');for(let i=0;i<100;i++)memory.record(id,'message',{role:'user',content:String(i)});
 const messages=memory.messages(id);assert.equal(messages.length,40);assert.equal(messages[0]?.content,'60');assert.equal(messages[39]?.content,'99');
 assert.equal(memory.db.prepare("SELECT count(*) AS n FROM events WHERE task_id=? AND kind='message'").get(id)?.n,101);
 assert.ok(memory.db.prepare("EXPLAIN QUERY PLAN SELECT body FROM events WHERE task_id=? AND kind='message' ORDER BY id DESC LIMIT 40").all(id).some(r=>String(r.detail).includes('events_task_kind_id')));memory.close();
});
test('mock HTTP transport enforces body caps, types, encoding and pins checked DNS',async()=>{
 const {EventEmitter}=await import('node:events');
 const resolver=async()=>[{address:'93.184.216.34',family:4}];
 const run=(headers:Record<string,string>,chunks:Buffer[])=>{
   const send:any=(_url:any,options:any,onResponse:any)=>{
     assert.equal(options.headers['Accept-Encoding'],'identity');assert.equal(options.headers.Cookie,undefined);assert.equal(options.agent,false);
     options.lookup('example.com',{},(err:any,address:string)=>{assert.equal(err,null);assert.equal(address,'93.184.216.34');});
     const req:any=new EventEmitter();req.end=()=>queueMicrotask(()=>{
       const res:any=new EventEmitter();res.statusCode=200;res.headers=headers;let destroyed=false;
       res.destroy=(error?:Error)=>{destroyed=true;if(error)queueMicrotask(()=>res.emit('error',error));};
       onResponse(res);if(destroyed)return;for(const chunk of chunks){res.emit('data',chunk);if(destroyed)return;}res.emit('end');
     });return req;
   };
   return pinnedRequest(new URL('https://example.com'),AbortSignal.timeout(1000),resolver as any,send,send);
 };
 assert.equal((await run({'content-type':'text/plain'},[Buffer.from('ok')])).body,'ok');
 await assert.rejects(run({'content-type':'text/plain','content-length':'524289'},[]),/512 KiB/);
 await assert.rejects(run({'content-type':'text/plain'},[Buffer.alloc(300000),Buffer.alloc(300000)]),/512 KiB/);
 await assert.rejects(run({'content-type':'application/octet-stream'},[]),/Unsupported/);
 await assert.rejects(run({'content-type':'text/plain','content-encoding':'gzip'},[]),/Unsupported/);
});
test('DNS deadline stops unresolved lookups without making a connection',async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(pinnedRequest(new URL('https://example.com'),controller.signal,(()=>new Promise(()=>{})) as any),/deadline/);
});
