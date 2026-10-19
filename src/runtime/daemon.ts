import {setTimeout as sleep} from 'node:timers/promises';
import {AgentLoop,type Tool} from '../agent/loop.js';
import type {Model} from '../models/router.js';
import {Reminders} from './reminders.js';
import {RuntimeStore,type Rule} from './store.js';
export class Daemon {
  private active=false;
  constructor(readonly store:RuntimeStore,private model:Model,private tools:Record<string,Tool>,private rules:Rule[]=[]){ }
  async tick(signal?:AbortSignal){
    if(this.active)throw new Error('Daemon tick already active');this.active=true;
    try{
      this.store.due();
      for(const m of new Reminders(this.store.memory).fire())console.log('\u{1F514} '+m);
      const tasks=this.store.memory.db.prepare("SELECT id FROM tasks WHERE status='queued' ORDER BY rowid LIMIT 20").all();
      for(const task of tasks){if(signal?.aborted)break;const id=String(task.id);
        const loop=new AgentLoop(this.store.memory,this.model,this.tools,async(tool,args)=>this.store.approve(id,tool,args,this.rules));
        // A failure is terminal until the local owner explicitly resumes it.
        try{await loop.run(id,signal);}catch{console.error(`Task ${id} failed; inspect status locally.`);}
      }
    }finally{this.active=false;}
  }
  async run(signal:AbortSignal,interval=1000){while(!signal.aborted){await this.tick(signal);try{await sleep(interval,undefined,{signal});}catch{if(!signal.aborted)throw new Error('Daemon timer failed');}}}
}
