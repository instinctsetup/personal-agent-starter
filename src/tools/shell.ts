import {execFile} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {resolve,sep} from 'node:path';
// Opt-in command runner. NOT A SANDBOX: the command runs with your own user account's permissions
// and can read/write any file or use the network that you can. The only controls are: explicit
// opt-in, exact-argv human approval per call, no shell (so no pipes/expansion), start directory
// inside the workspace, timeout, output cap and a trimmed environment.
export const COMMAND_WARNING='WARNING: this runs a program with YOUR user permissions. It is not sandboxed and can access any file or network you can. Approve only if you understand the exact command.';
export class CommandRunner {
  constructor(readonly root:string,private timeoutMs=30000,private maxOutput=20000){}
  async run(command:string,args:string[],cwd='.'):Promise<{exitCode:number|null;stdout:string;stderr:string;truncated:boolean;timedOut:boolean}>{
    const base=realpathSync(resolve(this.root)),dir=realpathSync(resolve(base,cwd));
    if(dir!==base&&!dir.startsWith(base+sep))throw new Error('Start directory must be inside the workspace');
    const env:Record<string,string>={};for(const k of ['PATH','HOME','LANG','TERM'])if(process.env[k])env[k]=process.env[k]!;
    return await new Promise(res=>{
      execFile(command,args,{cwd:dir,env,timeout:this.timeoutMs,maxBuffer:this.maxOutput*4,shell:false,encoding:'utf8'},(err:any,stdout,stderr)=>{
        const cut=(s:string)=>s.length>this.maxOutput?s.slice(0,this.maxOutput):s;
        res({exitCode:err?(typeof err.code==='number'?err.code:null):0,stdout:cut(stdout??''),stderr:cut(stderr??String(err?.message??'')),truncated:(stdout??'').length>this.maxOutput||(stderr??'').length>this.maxOutput,timedOut:Boolean(err?.killed)});
      });
    });
  }
}
