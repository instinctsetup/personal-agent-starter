import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {updateEnv,connectEmail,connectTelegram,connectSlack,type IO} from '../src/connect.js';

async function withEnv(fn:(p:string)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),'connect-'));
  const p=join(dir,'.env');
  try{await fn(p);}finally{await rm(dir,{recursive:true,force:true});}
}
function mkio(answers:string[],hidden:string[]=[]){const printed:string[]=[];let i=0,j=0;
  const io:IO={ask:async()=>answers[i++]??'',askHidden:async()=>hidden[j++]??'',print:(s)=>{printed.push(s);}};
  return {io,printed};}

test('updateEnv replaces existing keys, appends missing, keeps mode 600',async()=>{
  await withEnv(async(p)=>{
    await updateEnv(p,{SMTP_HOST:'smtp.gmail.com'});
    await updateEnv(p,{SMTP_HOST:'smtp.example.com',SMTP_PASSWORD:'s3cr3t'});
    const text=await readFile(p,'utf8');
    assert.equal((text.match(/^SMTP_HOST=/gm)||[]).length,1);
    assert.match(text,/SMTP_HOST=smtp\.example\.com/);
    assert.match(text,/SMTP_PASSWORD=s3cr3t/);
    assert.equal((await stat(p)).mode&0o777,0o600);
  });
});
test('updateEnv rejects invalid keys',async()=>{
  await withEnv(async(p)=>{await assert.rejects(()=>updateEnv(p,{'BAD KEY':'x'}));});
});
test('connectEmail stores app password hidden and sends test mail without logging the secret',async()=>{
  await withEnv(async(p)=>{
    const sent:unknown[]=[];
    const {io,printed}=mkio(['me@gmail.com','smtp.gmail.com','465','yes'],['app-pass-123']);
    await connectEmail(io,p,{sendTest:async(cfg,to)=>{sent.push({cfg,to});}});
    const text=await readFile(p,'utf8');
    assert.match(text,/SMTP_USER=me@gmail\.com/);
    assert.match(text,/SMTP_PASSWORD=app-pass-123/);
    assert.match(text,/MAIL_FROM=me@gmail\.com/);
    assert.equal((await stat(p)).mode&0o777,0o600);
    assert.equal((sent[0] as any).to,'me@gmail.com');
    assert.equal((sent[0] as any).cfg.pass,'app-pass-123');
    assert.ok(!printed.join('\n').includes('app-pass-123'),'secret must never be printed');
  });
});
test('connectEmail refuses invalid address and empty password without writing',async()=>{
  await withEnv(async(p)=>{
    const {io}=mkio(['not-an-email'],[]);
    await assert.rejects(()=>connectEmail(io,p,{sendTest:async()=>{}}));
    const {io:io2}=mkio(['me@gmail.com','smtp.gmail.com','465'],['']);
    await assert.rejects(()=>connectEmail(io2,p,{sendTest:async()=>{}}));
  });
});
test('connectEmail skips test mail unless confirmed with yes',async()=>{
  await withEnv(async(p)=>{
    let calls=0;
    const {io}=mkio(['me@gmail.com','smtp.gmail.com','587','no'],['x']);
    await connectEmail(io,p,{sendTest:async()=>{calls++;}});
    assert.equal(calls,0);
    const text=await readFile(p,'utf8');
    assert.match(text,/SMTP_PORT=587/);
  });
});
test('connectTelegram verifies token and saves chat allowlist',async()=>{
  await withEnv(async(p)=>{
    const {io,printed}=mkio(['123456'],['tok-abc']);
    await connectTelegram(io,p,{verifyTelegram:async(t)=>{assert.equal(t,'tok-abc');return 'demobot';}});
    const text=await readFile(p,'utf8');
    assert.match(text,/TELEGRAM_BOT_TOKEN=tok-abc/);
    assert.match(text,/TELEGRAM_ALLOWED_CHATS=123456/);
    assert.ok(!printed.join('\n').includes('tok-abc'));
  });
});
test('connectTelegram saves even when verification is unreachable, with a warning',async()=>{
  await withEnv(async(p)=>{
    const {io,printed}=mkio(['42'],['tok-x']);
    await connectTelegram(io,p,{verifyTelegram:async()=>{throw new Error('offline');}});
    assert.match(await readFile(p,'utf8'),/TELEGRAM_BOT_TOKEN=tok-x/);
    assert.ok(printed.join('\n').includes('Could not verify'));
  });
});
test('connectSlack validates IDs and stores signing secret hidden',async()=>{
  await withEnv(async(p)=>{
    const {io,printed}=mkio(['T123','C456','U789'],['slack-secret']);
    await connectSlack(io,p);
    const text=await readFile(p,'utf8');
    assert.match(text,/SLACK_SIGNING_SECRET=slack-secret/);
    assert.ok(!printed.join('\n').includes('slack-secret'));
    const {io:bad}=mkio(['nope','C456','U789'],['s']);
    await assert.rejects(()=>connectSlack(bad,p));
  });
});
