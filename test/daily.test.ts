import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Memory} from '../src/memory/db.js';
import {Reminders} from '../src/runtime/reminders.js';
import {compactTask} from '../src/memory/compact.js';
import {CommandRunner} from '../src/tools/shell.js';
import {loadPlugins} from '../src/tools/plugins.js';
import {checkConfig} from '../src/config.js';
test('reminders fire once and create notifications',()=>{
 const r=new Reminders(new Memory(':memory:'));r.add('2026-01-01T10:00:00Z','call mom');
 assert.equal(r.fire(new Date('2026-01-01T09:59:00Z')).length,0);
 assert.equal(r.fire(new Date('2026-01-01T10:01:00Z')).length,1);
 assert.equal(r.fire(new Date('2026-01-01T10:02:00Z')).length,0);
 assert.equal(r.unseen().length,1);r.markSeen();assert.equal(r.unseen().length,0);
 assert.throws(()=>r.add('nope','x'));const id=r.add('2030-01-01T00:00:00Z','later');r.cancel(id);assert.throws(()=>r.cancel(id));
});
test('compaction summarizes old turns once and keeps originals',async()=>{
 const m=new Memory(':memory:'),id=m.create('goal');for(let i=0;i<30;i++)m.record(id,'message',{role:i%2?'assistant':'user',content:'m'+i});
 let calls=0;const model={complete:async()=>{calls++;return 'SUMMARY';}};
 const a=await compactTask(m,model,id,10,5);assert.ok(a.compacted>0);assert.equal(m.summary(id),'SUMMARY');
 assert.equal((await compactTask(m,model,id,10,5)).compacted,0);assert.equal(calls,1);
 assert.equal(m.db.prepare("SELECT count(*) c FROM events WHERE kind='message'").get()!.c,31);
});
test('command runner: no shell, cwd confined, output cap, timeout',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cr-'));mkdirSync(join(root,'sub'));
 const r=new CommandRunner(root,2000,50);
 const ok=await r.run(process.execPath,['-e','console.log("hi")']);assert.equal(ok.exitCode,0);assert.equal(ok.stdout.trim(),'hi');
 const noShell=await r.run(process.execPath,['-e','console.log(process.argv[1])','a; echo injected']);assert.ok(!noShell.stdout.includes('injected\n')||noShell.stdout.includes('a; echo injected'));
 await assert.rejects(r.run(process.execPath,['-e','1'],'..'));
 symlinkSync(tmpdir(),join(root,'link'));await assert.rejects(r.run(process.execPath,['-e','1'],'link'));
 const big=await r.run(process.execPath,['-e','console.log("x".repeat(500))']);assert.equal(big.stdout.length,50);assert.equal(big.truncated,true);
 const slow=await new CommandRunner(root,300).run(process.execPath,['-e','setTimeout(()=>{},5000)']);assert.equal(slow.timedOut,true);
 const bad=await r.run('definitely-not-a-command-xyz',[]);assert.notEqual(bad.exitCode,0);
});
test('plugins load with validation and prefix',async()=>{
 const d=mkdtempSync(join(tmpdir(),'pl-'));
 writeFileSync(join(d,'a.mjs'),"export default z=>({hi:{description:'d',schema:z.object({n:z.string()}).strict(),run:async a=>a.n}})");
 const t=await loadPlugins(d,{});assert.deepEqual(Object.keys(t),['plugin_hi']);assert.equal(await t.plugin_hi!.run({n:'x'}),'x');
 await assert.rejects(loadPlugins(d,{plugin_hi:t.plugin_hi!}));
 const e=mkdtempSync(join(tmpdir(),'pl-'));writeFileSync(join(e,'b.mjs'),'export default 5');await assert.rejects(loadPlugins(e,{}));
 await assert.rejects(loadPlugins('/nonexistent-dir-xyz',{}));
});
test('config check flags problems',()=>{
 assert.ok(checkConfig({}).some(x=>x.level==='error'));
 assert.ok(checkConfig({MODEL_NAME:'m',MODEL_PROVIDER:'openai'}).some(x=>x.message.includes('MODEL_API_KEY')));
 assert.ok(checkConfig({MODEL_NAME:'m',ENABLE_COMMAND_RUNNER:'true'}).some(x=>x.level==='warn'));
 assert.ok(checkConfig({MODEL_NAME:'m'}).some(x=>x.level==='ok'));
});
