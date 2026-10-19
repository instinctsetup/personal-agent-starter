import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {z} from 'zod';
import {Memory} from '../src/memory/db.js';
import {AgentLoop} from '../src/agent/loop.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {Daemon} from '../src/runtime/daemon.js';
import {receiveBot,type BotConfig} from '../src/runtime/bots.js';
import {VectorMemory,cosine} from '../src/memory/vector.js';
const demo=(calls:{n:number})=>({demo:{description:'t',schema:z.object({a:z.number()}),run:async()=>{calls.n++;return 'ok';}}});
test('daemon queues unapproved action, runs it only after exact approval',async()=>{
 const memory=new Memory(':memory:'),store=new RuntimeStore(memory),id=memory.create('go'),calls={n:0};let turn=0;
 const model={complete:async()=>JSON.stringify(turn++%2===0?{type:'tool',tool:'demo',args:{a:1},reason:'x'}:{type:'done',message:'ok'})};
 const d=new Daemon(store,model,demo(calls));
 await d.tick();assert.equal(calls.n,0);assert.equal(memory.task(id).status,'waiting');
 const p=memory.db.prepare("SELECT id FROM approvals WHERE status='pending'").all();assert.equal(p.length,1);
 store.review(String(p[0]!.id),true);memory.db.prepare("UPDATE tasks SET status='queued' WHERE id=?").run(id);
 turn=0;await d.tick();assert.equal(calls.n,1);assert.equal(memory.task(id).status,'completed');memory.close();
});
test('auto-approve only exact safe reads; writes never auto-approved',()=>{
 const store=new RuntimeStore(new Memory(':memory:'));
 const rules=[{tool:'file_read',args:{path:'a',start:1,end:2}},{tool:'mail_send',args:{to:'x@y.z'}}];
 assert.equal(store.approve('t','file_read',{end:2,start:1,path:'a'},rules),true);
 assert.equal(store.approve('t','file_read',{path:'b',start:1,end:2},rules),false);
 assert.equal(store.approve('t','mail_send',{to:'x@y.z'},rules),false);
});
test('cron jobs persist, fire once, coalesce missed runs',()=>{
 const memory=new Memory(':memory:'),store=new RuntimeStore(memory);
 const t0=new Date('2026-01-01T00:00:00Z');store.addJob('*/5 * * * *','UTC','check',t0);
 assert.equal(store.due(new Date('2026-01-01T00:04:00Z')).length,0);
 assert.equal(store.due(new Date('2026-01-01T02:00:00Z')).length,1);
 assert.equal(store.due(new Date('2026-01-01T02:01:00Z')).length,0);
 assert.throws(()=>store.addJob('* * * * * *','UTC','x'));assert.throws(()=>store.addJob('bad','UTC','x'));
});
const cfg:BotConfig={telegramSecret:'s3',telegramUsers:['1'],telegramChats:['9'],slackSecret:'sig',slackUsers:['U1'],slackChannels:['C1'],slackTeam:'T1'};
test('telegram hook authenticates, filters and dedupes',()=>{
 const store=new RuntimeStore(new Memory(':memory:'));
 const upd=(uid=1)=>JSON.stringify({update_id:5,message:{from:{id:uid,is_bot:false},chat:{id:9},text:'hi'}});
 assert.throws(()=>receiveBot(store,cfg,'/telegram',{'x-telegram-bot-api-secret-token':'bad'},upd()));
 assert.throws(()=>receiveBot(store,cfg,'/telegram',{'x-telegram-bot-api-secret-token':'s3'},upd(2)));
 const a=receiveBot(store,cfg,'/telegram',{'x-telegram-bot-api-secret-token':'s3'},upd()),b=receiveBot(store,cfg,'/telegram',{'x-telegram-bot-api-secret-token':'s3'},upd());
 assert.equal(a.task,b.task);
});
test('slack hook verifies signature, freshness, team and user',()=>{
 const store=new RuntimeStore(new Memory(':memory:')),now=Date.now(),ts=String(Math.floor(now/1000));
 const body=JSON.stringify({type:'event_callback',team_id:'T1',event_id:'E1',event:{type:'message',user:'U1',channel:'C1',text:'do it'}});
 const sign=(t:string,b:string)=>'v0='+createHmac('sha256','sig').update(`v0:${t}:${b}`).digest('hex');
 assert.ok(receiveBot(store,cfg,'/slack',{'x-slack-request-timestamp':ts,'x-slack-signature':sign(ts,body)},body,now).task);
 assert.throws(()=>receiveBot(store,cfg,'/slack',{'x-slack-request-timestamp':ts,'x-slack-signature':'v0=bad'},body,now));
 const old=String(Math.floor(now/1000)-1000);assert.throws(()=>receiveBot(store,cfg,'/slack',{'x-slack-request-timestamp':old,'x-slack-signature':sign(old,body)},body,now));
 const other=body.replace('U1','U2');assert.throws(()=>receiveBot(store,cfg,'/slack',{'x-slack-request-timestamp':ts,'x-slack-signature':sign(ts,other)},other,now));
});
test('vector memory ranks semantically with mocked embeddings and rejects bad vectors',async()=>{
 const memory=new Memory(':memory:');const table:Record<string,number[]>={cat:[1,0],kitten:[0.9,0.1],car:[0,1]};
 const v=new VectorMemory(memory,{id:'mock',embed:async t=>table[t]??[1,1]});
 await v.remember('cat');const car=await v.remember('car');
 assert.equal((await v.recall('kitten'))[0]?.text,'cat');
 memory.forget(car);assert.equal((await v.recall('kitten')).length,1);
 const bad=new VectorMemory(memory,{id:'bad',embed:async()=>[0,0]});await assert.rejects(bad.remember('x'));
 assert.throws(()=>cosine([1],[1,2]));memory.close();
});
