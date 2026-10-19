import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mkdir } from 'node:fs/promises';
import { Memory } from './memory/db.js';
import { Router } from './models/router.js';
import { AgentLoop } from './agent/loop.js';
import { registry } from './tools/registry.js';
const rl=createInterface({input:stdin,output:stdout});
const memory=new Memory(process.env.AGENT_DB??'agent_memory.db');
const manual=async(message:string)=>{console.log(message);await rl.question('Press Enter after completing this step locally. ');};
const {tools,browser}=registry(manual);
const loop=new AgentLoop(memory,new Router(),tools,async(name,args)=>{
  console.log(`\nREVIEW ${name}\n${JSON.stringify(args,null,2)}`);
  return (await rl.question('Allow this exact call? Type yes: '))==='yes';
});
loop.on('step',({decision})=>console.log(decision.type==='tool'?`Next: ${decision.tool}: ${decision.reason}`:decision.message));
loop.on('private-result',result=>console.log('PRIVATE LOCAL RESULT (not sent to model):',result));
loop.on('result',message=>console.log(message));
const abort=new AbortController(); process.once('SIGINT',()=>{abort.abort();console.log('Stopping after the active operation.');});
try {
  await mkdir(process.env.WORKSPACE_ROOT??'./workspace',{recursive:true,mode:0o700});
  const [command,...args]=process.argv.slice(2);
  if(command==='run') {const goal=args.join(' ').trim();if(!goal)throw new Error('Provide a goal');const id=memory.create(goal);console.log(`Task ID: ${id}`);await loop.run(id,abort.signal);}
  else if(command==='resume') {if(!args[0])throw new Error('Provide task ID');await loop.run(args[0],abort.signal);}
  else if(command==='status') {console.log(args[0]?memory.task(args[0]):memory.db.prepare('SELECT id,status,steps,goal FROM tasks ORDER BY rowid DESC LIMIT 20').all());}
  else if(command==='login') {const [url,successSelector]=args;if(!url||!successSelector)throw new Error('Usage: login URL SUCCESS_SELECTOR');await browser.start();await browser.login_to_site({url,userSelector:'input[type=email]',passwordSelector:'input[type=password]',submitSelector:'button[type=submit]',successSelector},manual);}
  else if(command==='serve') {const { serve }=await import('./server.js');const server=await serve(memory);console.log(`Read-only dashboard: http://127.0.0.1:${(server.address() as any).port}`);await new Promise<void>(resolve=>{const timer=setInterval(()=>{if(abort.signal.aborted){clearInterval(timer);server.close(()=>resolve());}},250);});}
  else console.log('Commands: run "goal" | resume TASK_ID | status [TASK_ID] | login URL SUCCESS_SELECTOR | serve');
} catch(error) {console.error(error instanceof Error?error.message:'Execution failed');process.exitCode=1;}
finally {await browser.close();memory.close();rl.close();}
