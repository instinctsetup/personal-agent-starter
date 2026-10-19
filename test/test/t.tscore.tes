import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {Memory} from '../src/memory/db.js';
import {AgentLoop} from '../src/agent/loop.js';
import {FileManager} from '../src/tools/fileManager.js';
import {Router} from '../src/models/router.js';
import {serve} from '../src/server.js';
test('SQLite persists history and converts interrupted running tasks to waiting',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agent-db-'));try{const path=join(dir,'memory.db');const first=new Memory(path),id=first.create('hello');first.state(id,'running');first.close();const next=new Memory(path);assert.equal(next.task(id).status,'waiting');assert.equal(next.messages(id)[0]?.content,'hello');next.close();}finally{await rm(dir,{recursive:true,force:true});}
});
test('file chunks, compare-and-swap patches, traversal and symlink rejection',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agent-files-'));try{const files=new FileManager(root);await files.create('src/demo.txt','a\nb\nc');assert.equal(await files.read('src/demo.txt',2,3),'2: b\n3: c');await assert.rejects(files.patch('src/demo.txt',2,2,'wrong','new'));await files.patch('src/demo.txt',2,2,'b','new');assert.equal(await readFile(join(root,'src/demo.txt'),'utf8'),'a\nnew\nc');await assert.rejects(files.path('../outside'));await assert.rejects(files.path('.env'));await symlink(tmpdir(),join(root,'link'));await assert.rejects(files.path('link/file'));}finally{await rm(root,{recursive:true,force:true});}
});
test('approved tool execution and completion',async()=>{
 const memory=new Memory(':memory:'),id=memory.create('do a thing');let calls=0,turns=0;
 const model={complete:async()=>JSON.stringify(++turns===1?{type:'tool',tool:'demo',args:{},reason:'test'}:{type:'done',message:'finished'})};
 const loop=new AgentLoop(memory,model,{demo:{description:'test',schema:z.object({}),run:async()=>{calls++;return 'ok';}}},async()=>true);await loop.run(id);assert.equal(calls,1);assert.equal(memory.task(id).status,'completed');memory.close();
});
test('denied tools never execute',async()=>{
 const memory=new Memory(':memory:'),id=memory.create('test');let calls=0;
 const loop=new AgentLoop(memory,{complete:async()=>JSON.stringify({type:'tool',tool:'demo',args:{},reason:'test'})},{demo:{description:'test',schema:z.object({}),run:async()=>{calls++;}}},async()=>false);await loop.run(id);assert.equal(calls,0);assert.equal(memory.task(id).status,'waiting');memory.close();
});
test('invalid model JSON fails safely',async()=>{const memory=new Memory(':memory:'),id=memory.create('test');const loop=new AgentLoop(memory,{complete:async()=> 'bad json'},{},async()=>true);await assert.rejects(loop.run(id));assert.equal(memory.task(id).status,'failed');memory.close();});
test('step budget pauses instead of running forever',async()=>{const memory=new Memory(':memory:'),id=memory.create('test');const loop=new AgentLoop(memory,{complete:async()=>JSON.stringify({type:'tool',tool:'demo',args:{},reason:'test'})},{demo:{description:'test',schema:z.object({}),run:async()=> 'ok'}},async()=>true,2);await loop.run(id);assert.equal(memory.task(id).status,'waiting');assert.equal(memory.task(id).steps,2);memory.close();});
test('sensitive results never enter model history',async()=>{const memory=new Memory(':memory:'),id=memory.create('test');const loop=new AgentLoop(memory,{complete:async()=>JSON.stringify({type:'tool',tool:'private',args:{},reason:'test'})},{private:{description:'test',schema:z.object({}),run:async()=> 'SECRET-OTP',persistOutput:false}},async()=>true,1);await loop.run(id);assert.ok(!JSON.stringify(memory.messages(id)).includes('SECRET-OTP'));memory.close();});
test('router supports all four public HTTP protocols with mocked endpoints',async()=>{
 const originalFetch=globalThis.fetch,originalEnv={...process.env};try{for(const provider of ['openai','openrouter','anthropic','ollama']){process.env.MODEL_PROVIDER=provider;process.env.MODEL_NAME='test';process.env.MODEL_API_KEY='test';process.env.MODEL_BASE_URL='https://model.example';globalThis.fetch=async(input,options)=>{assert.match(String(input),provider==='anthropic'?/\/messages$/:provider==='ollama'?/\/api\/chat$/:/\/chat\/completions$/);assert.ok(options?.signal);return new Response(JSON.stringify(provider==='anthropic'?{content:[{type:'text',text:'ok'}]}:provider==='ollama'?{message:{content:'ok'}}:{choices:[{message:{content:'ok'}}]}));};assert.equal(await new Router().complete([{role:'user',content:'hello'}]),'ok');}}finally{globalThis.fetch=originalFetch;process.env=originalEnv;}
});
test('dashboard is read-only and returns local status',async()=>{const memory=new Memory(':memory:');memory.create('test');const server=await serve(memory,0);try{const port=(server.address() as any).port;const response=await fetch(`http://127.0.0.1:${port}/`);assert.equal(response.status,200);assert.match(await response.text(),/Personal Agent/);assert.equal((await fetch(`http://127.0.0.1:${port}/`,{method:'POST'})).status,403);}finally{server.close();memory.close();}});
