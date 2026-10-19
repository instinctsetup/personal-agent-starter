import {randomUUID} from 'node:crypto';
import type {Memory} from '../memory/db.js';
// One-shot local reminders. A reminder only writes a notification row and prints it; it never runs tools.
export class Reminders {
  constructor(readonly memory:Memory){memory.db.exec(`
    CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY,due_at TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending');
    CREATE INDEX IF NOT EXISTS reminders_due ON reminders(status,due_at);
    CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY,created_at TEXT NOT NULL,message TEXT NOT NULL,seen INTEGER NOT NULL DEFAULT 0);`);}
  add(dueAt:string,text:string):string{
    const t=Date.parse(dueAt);if(Number.isNaN(t))throw new Error('Use an ISO time such as 2026-01-31T09:00:00+05:30');
    if(!text.trim()||text.length>1000)throw new Error('Reminder text must be 1-1000 characters');
    const id=randomUUID();this.memory.db.prepare('INSERT INTO reminders(id,due_at,text) VALUES(?,?,?)').run(id,new Date(t).toISOString(),text.trim());return id;
  }
  list(){return this.memory.db.prepare("SELECT id,due_at,text,status FROM reminders ORDER BY due_at LIMIT 100").all();}
  cancel(id:string){const r=this.memory.db.prepare("UPDATE reminders SET status='cancelled' WHERE id=? AND status='pending'").run(id);if(!r.changes)throw new Error('No pending reminder with that ID');}
  fire(now=new Date()):string[]{
    const out:string[]=[];this.memory.db.exec('BEGIN IMMEDIATE');
    try{
      for(const r of this.memory.db.prepare("SELECT id,text,due_at FROM reminders WHERE status='pending' AND due_at<=? ORDER BY due_at").all(now.toISOString())){
        const msg=`Reminder (due ${r.due_at}): ${r.text}`;
        this.memory.db.prepare("UPDATE reminders SET status='fired' WHERE id=?").run(String(r.id));
        this.memory.db.prepare('INSERT INTO notifications(created_at,message) VALUES(?,?)').run(now.toISOString(),msg);out.push(msg);
      }
      this.memory.db.exec('COMMIT');return out;
    }catch(e){this.memory.db.exec('ROLLBACK');throw e;}
  }
  unseen(){return this.memory.db.prepare('SELECT id,created_at,message FROM notifications WHERE seen=0 ORDER BY id LIMIT 100').all();}
  markSeen(){this.memory.db.prepare('UPDATE notifications SET seen=1 WHERE seen=0').run();}
}
