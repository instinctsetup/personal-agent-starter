import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mkdir,readFile,open,unlink } from 'node:fs/promises';
import {RuntimeStore,type Rule} from './runtime/store.js';
import {Daemon} from './runtime/daemon.js';
import {botServer} from './runtime/bots.js';
import { Memory } from './memory/db.js';
import { Router } from './models/router.js';
import { AgentLoop } from './agent/loop.js';
import {Reminders} from './runtime/reminders.js';
import {compactTask} from './memory/compact.js';
import {checkConfig} from './config.js';
import {connectEmail,connectTelegram,connectSlack,readHidden,readVisible,type IO} from './connect.js';
import {loadPlugins} from './tools/plugins.js';
import {COMMAND_WARNING} from './tools/shell.js';
import { registry } from './tools/registry.js';
const rl=createInterface({input:stdin,output:stdout});
const dbPath=process.env.AGENT_DB??'agent_memory.db';
const memory=new Memory(dbPath,false);
const runtime=new RuntimeStore(memory);
let releaseLock:(()=>Promise<void>)|undefined;
let hooks:Awaited<ReturnType<typeof botServer>>|undefined;
const manual=async(message:string)=>{if(process.argv[2]==='daemon')throw new Error('Manual login requires the interactive CLI');console.log(message);await rl.question('Press Enter after completing this step locally. ');};
const {tools,browser}=registry(manual,memory);
if(process.env.ENABLE_PLUGINS==='true'&&process.env.PLUGIN_DIR&&['run','resume','daemon'].includes(process.argv[2]??''))Object.assign(tools,await loadPlugins(process.env.PLUGIN_DIR,tools));
const reminders=new Reminders(memory);
const loop=new AgentLoop(memory,new Router(),tools,async(name,args)=>{
  if(name==='run_command')console.log('\n'+COMMAND_WARNING);
  console.log(`\nREVIEW ${name}\n${JSON.stringify(args,null,2)}`);
  return (await rl.question('Allow this exact call? Type yes: '))==='yes';
});
loop.on('step',({decision})=>console.log(decision.type==='tool'?`Next: ${decision.tool}: ${decision.reason}`:decision.type==='plan'?`Plan: ${decision.steps.join(' -> ')}`:decision.type==='reflect'?`Review: ${decision.observation} Next: ${decision.next}`:decision.message));
loop.on('private-result',result=>console.log('PRIVATE LOCAL RESULT (not sent to model):',result));
loop.on('result',message=>console.log(message));
const abort=new AbortController(); for(const sig of ['SIGINT','SIGTERM'] as const)process.once(sig,()=>{abort.abort();console.log('Stopping after the active operation.');});
try {
  await mkdir(process.env.WORKSPACE_ROOT??'./workspace',{recursive:true,mode:0o700});
  const [command,...args]=process.argv.slice(2);
  if(['run','resume','daemon','login'].includes(command??'')){
    // One execution process per database. A crashed process leaves a lock for manual inspection.
    const handle=await open(dbPath+'.lock','wx',0o600);await handle.writeFile(String(process.pid));await handle.close();
    releaseLock=()=>unlink(dbPath+'.lock');
    memory.db.prepare("UPDATE tasks SET status='waiting' WHERE status='running'").run();
  }
  if(command==='daemon'){
    const rules:Rule[]=process.env.AGENT_POLICY?JSON.parse(await readFile(process.env.AGENT_POLICY,'utf8')):[];
    if(!Array.isArray(rules)||rules.some(r=>!r||typeof r.tool!=='string'||!Object.hasOwn(r,'args')))throw new Error('Policy must be an array of exact {tool,args} rules');
    if(process.env.BOT_HOOKS==='true'){
      const list=(name:string)=>(process.env[name]??'').split(',').map(s=>s.trim()).filter(Boolean);
      hooks=await botServer(runtime,{telegramSecret:process.env.TELEGRAM_WEBHOOK_SECRET,telegramUsers:list('TELEGRAM_ALLOWED_USERS'),telegramChats:list('TELEGRAM_ALLOWED_CHATS'),slackSecret:process.env.SLACK_SIGNING_SECRET,slackUsers:list('SLACK_ALLOWED_USERS'),slackChannels:list('SLACK_ALLOWED_CHANNELS'),slackTeam:process.env.SLACK_TEAM_ID});
      console.log('Bot hooks on loopback port 8788. Configure your own HTTPS reverse proxy.');
    }
    console.log('Daemon active. Unknown actions queue for local review; no automatic outbound messages.');
    await new Daemon(runtime,new Router(),tools,rules).run(abort.signal);
  }
  else if(command==='approvals'){console.log(memory.db.prepare("SELECT * FROM approvals WHERE status='pending' ORDER BY rowid").all());}
  else if(command==='approve'||command==='deny'){
    if(!args[0])throw new Error('Provide approval ID');
    const row=memory.db.prepare('SELECT * FROM approvals WHERE id=?').get(args[0]);if(!row)throw new Error('Unknown approval');
    console.log(row);
    if((await rl.question('Confirm this exact decision? Type yes: '))!=='yes')throw new Error('Not confirmed');
    runtime.review(args[0],command==='approve');
    if(command==='approve')memory.db.prepare("UPDATE tasks SET status='queued' WHERE id=? AND status='waiting'").run(String(row.task_id));
  }
  else if(command==='schedule'){
    if(args[0]==='add'){if(!args[1]||!args[2]||!args.slice(3).join(' '))throw new Error('schedule add "CRON" "TIMEZONE" "GOAL"');console.log(runtime.addJob(args[1],args[2],args.slice(3).join(' ')));}
    else if(args[0]==='disable'){if(!args[1])throw new Error('Provide job ID');memory.db.prepare('UPDATE jobs SET enabled=0 WHERE id=?').run(args[1]);}
    else console.log(memory.db.prepare('SELECT * FROM jobs').all());
  }
  else if(command==='remind'){
    if(args[0]==='add'){if(!args[1]||!args.slice(2).join(' '))throw new Error('remind add ISO_TIME "text"');console.log(reminders.add(args[1],args.slice(2).join(' ')));}
    else if(args[0]==='cancel'){if(!args[1])throw new Error('Provide reminder ID');reminders.cancel(args[1]);console.log('Cancelled');}
    else console.log(reminders.list());
  }
  else if(command==='notifications'){const n=reminders.fire().length;const u=reminders.unseen();console.log(u.length?u.map(x=>`${x.created_at} ${x.message}`).join('\n'):'No new notifications');if(args[0]==='clear')reminders.markSeen();void n;}
  else if(command==='connect'){
    const service=args[0];
    // Close the shared readline so it cannot echo or consume secrets; connect uses raw readers.
    rl.close();
    const io:IO={ask:readVisible,askHidden:readHidden,print:(s:string)=>console.log(s)};
    if(service==='email')await connectEmail(io);
    else if(service==='telegram')await connectTelegram(io);
    else if(service==='slack')await connectSlack(io);
    else throw new Error('Usage: connect email|telegram|slack');
  }
  else if(command==='compact'){if(!args[0])throw new Error('Provide task ID');console.log(await compactTask(memory,new Router(),args[0]));}
  else if(command==='config'){const r=checkConfig(process.env);for(const x of r)console.log(`${x.level.toUpperCase()}: ${x.message}`);if(r.some(x=>x.level==='error'))process.exitCode=1;}
  else if(command==='enqueue'){const goal=args.join(' ').trim();if(!goal)throw new Error('Provide goal');console.log(memory.create(goal));}
  else if(command==='run') {const goal=args.join(' ').trim();if(!goal)throw new Error('Provide a goal');const id=memory.create(goal);console.log(`Task ID: ${id}`);await loop.run(id,abort.signal);}
  else if(command==='resume') {if(!args[0])throw new Error('Provide task ID');await loop.run(args[0],abort.signal);}
  else if(command==='status') {console.log(args[0]?memory.task(args[0]):memory.db.prepare('SELECT id,status,steps,goal FROM tasks ORDER BY rowid DESC LIMIT 20').all());}
  else if(command==='login') {const [url,successSelector]=args;if(!url||!successSelector)throw new Error('Usage: login URL SUCCESS_SELECTOR');await browser.start();await browser.login_to_site({url,userSelector:'input[type=email]',passwordSelector:'input[type=password]',submitSelector:'button[type=submit]',successSelector},manual);}
  else if(command==='serve') {const { serve }=await import('./server.js');const server=await serve(memory);console.log(`Read-only dashboard: http://127.0.0.1:${(server.address() as any).port}`);await new Promise<void>(resolve=>{const timer=setInterval(()=>{if(abort.signal.aborted){clearInterval(timer);server.close(()=>resolve());}},250);});}
  else console.log('Commands: run "goal" | resume TASK_ID | status [TASK_ID] | login URL SUCCESS_SELECTOR | serve | daemon | enqueue "goal" | approvals | approve ID | deny ID | schedule [add/disable] | remind [add ISO "text"|cancel ID] | notifications [clear] | compact TASK_ID | config | connect email|telegram|slack');
} catch(error) {console.error(error instanceof Error?error.message:'Execution failed');process.exitCode=1;}
finally {if(hooks)await new Promise<void>(resolve=>hooks!.close(()=>resolve()));await browser.close();memory.close();rl.close();await releaseLock?.();}
