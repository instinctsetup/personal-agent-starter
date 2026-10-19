import {randomUUID, createHash} from 'node:crypto';
import {CronExpressionParser} from 'cron-parser';
import type {Memory} from '../memory/db.js';
export type Rule={tool:string;args:unknown};
export function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value)??'null';
}
// Auto-approval is deliberately limited to exact, non-private local reads.
const safeReads=new Set(['file_read','git_status','memory_recall','memory_vector_recall']);
export class RuntimeStore {
  constructor(readonly memory:Memory){memory.db.exec(`
    CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,tool TEXT NOT NULL,args TEXT NOT NULL,digest TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending');
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,cron TEXT NOT NULL,timezone TEXT NOT NULL,goal TEXT NOT NULL,next_at TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
    CREATE INDEX IF NOT EXISTS approvals_task_digest ON approvals(task_id,digest);
    CREATE INDEX IF NOT EXISTS jobs_due ON jobs(enabled,next_at);
    CREATE TABLE IF NOT EXISTS receipts(source TEXT NOT NULL,event_id TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(source,event_id));
  `);}
  approve(task:string,tool:string,args:unknown,rules:Rule[]=[]):boolean {
    if(safeReads.has(tool)&&rules.some(r=>r.tool===tool&&canonical(r.args)===canonical(args)))return true;
    const body=canonical(args),digest=createHash('sha256').update(tool+'\n'+body).digest('hex');
    const row=this.memory.db.prepare('SELECT id,status FROM approvals WHERE task_id=? AND digest=? ORDER BY rowid DESC LIMIT 1').get(task,digest);
    if(row?.status==='approved'){
      this.memory.db.prepare("UPDATE approvals SET status='consumed' WHERE id=?").run(String(row.id));return true;
    }
    if(!row||row.status!=='pending')this.memory.db.prepare('INSERT INTO approvals(id,task_id,tool,args,digest) VALUES(?,?,?,?,?)').run(randomUUID(),task,tool,body,digest);
    return false;
  }
  review(id:string,allow:boolean){
    const result=this.memory.db.prepare("UPDATE approvals SET status=? WHERE id=? AND status='pending'").run(allow?'approved':'denied',id);
    if(!result.changes)throw new Error('Approval is not pending');
  }
  addJob(cron:string,timezone:string,goal:string,now=new Date()){
    if(!goal.trim()||goal.length>10000)throw new Error('Invalid goal');
    if(cron.trim().split(/\s+/).length!==5)throw new Error('Use five-field cron (minute precision)');
    const next=CronExpressionParser.parse(cron,{tz:timezone,currentDate:now}).next().toISOString(),id=randomUUID();
    this.memory.db.prepare('INSERT INTO jobs(id,cron,timezone,goal,next_at) VALUES(?,?,?,?,?)').run(id,cron,timezone,goal,next);return id;
  }
  due(now=new Date()):string[]{
    const ids:string[]=[];this.memory.db.exec('BEGIN IMMEDIATE');
    try {
      for(const job of this.memory.db.prepare('SELECT * FROM jobs WHERE enabled=1 AND next_at<=?').all(now.toISOString())){
        // Coalesce missed occurrences; advancing and queuing are atomic, never replay old slots.
        const id=this.memory.create(String(job.goal));ids.push(id);
        const next=CronExpressionParser.parse(String(job.cron),{tz:String(job.timezone),currentDate:now}).next().toISOString();
        this.memory.db.prepare('UPDATE jobs SET next_at=? WHERE id=?').run(next,String(job.id));
      }
      this.memory.db.exec('COMMIT');return ids;
    }catch(e){this.memory.db.exec('ROLLBACK');throw e;}
  }
  ingest(source:string,event:string,goal:string):string{
    if(!goal.trim()||goal.length>10000)throw new Error('Invalid bot text');
    this.memory.db.exec('BEGIN IMMEDIATE');
    try{
      const old=this.memory.db.prepare('SELECT task_id FROM receipts WHERE source=? AND event_id=?').get(source,event);
      if(old){this.memory.db.exec('COMMIT');return String(old.task_id);}
      const id=this.memory.create(goal);this.memory.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(source,event,id);this.memory.db.exec('COMMIT');return id;
    }catch(e){this.memory.db.exec('ROLLBACK');throw e;}
  }
}
