import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
export type Status = 'queued' | 'running' | 'waiting' | 'completed' | 'failed';
export class Memory {
  readonly db: DatabaseSync;
  constructor(path = 'agent_memory.db', recover = true) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(id UNINDEXED, text);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id), goal TEXT NOT NULL, status TEXT NOT NULL, steps INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, task_id TEXT REFERENCES tasks(id), kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE INDEX IF NOT EXISTS events_task_kind_id ON events(task_id,kind,id);
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);`);
    // A restart never replays an uncertain side effect automatically.
    if(recover)this.db.prepare("UPDATE tasks SET status='waiting' WHERE status='running'").run();
  }
  create(goal: string): string {
    const session = randomUUID(), id = randomUUID();
    this.db.prepare('INSERT INTO sessions(id) VALUES (?)').run(session);
    this.db.prepare('INSERT INTO tasks(id,session_id,goal,status) VALUES (?,?,?,?)').run(id, session, goal, 'queued');
    this.record(id, 'message', {role:'user', content:goal}); return id;
  }
  task(id: string) { const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id); if (!row) throw new Error('Unknown task'); return row; }
  state(id: string, status: Status) { this.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status,id); this.record(id,'status',{status}); }
  record(id: string, kind: string, body: unknown) { this.db.prepare('INSERT INTO events(task_id,kind,body) VALUES (?,?,?)').run(id,kind,JSON.stringify(body)); }
  messages(id: string, limit=40): Array<{role:'user'|'assistant';content:string}> { return this.db.prepare("SELECT body FROM events WHERE task_id=? AND kind='message' ORDER BY id DESC LIMIT ?").all(id,Math.max(1,Math.min(200,Math.floor(limit)||40))).reverse().map(r => JSON.parse(String(r.body))); }
  step(id: string) { this.db.prepare('UPDATE tasks SET steps=steps+1 WHERE id=?').run(id); }
  remember(text: string): string {
    if (!text.trim() || text.length > 10000) throw new Error('Notes must be 1-10000 characters');
    const id=randomUUID();
    this.db.exec('BEGIN');
    try {this.db.prepare('INSERT INTO notes(id,text) VALUES (?,?)').run(id,text);this.db.prepare('INSERT INTO notes_fts(id,text) VALUES (?,?)').run(id,text);this.db.exec('COMMIT');} catch(error){this.db.exec('ROLLBACK');throw error;}
    return id;
  }
  recall(query:string) {
    const tokens=query.match(/[\p{L}\p{N}_]+/gu)?.slice(0,12)??[];
    if(!tokens.length) return [];
    const expression=tokens.map(t=>'"'+t+'"').join(' OR ');
    return this.db.prepare('SELECT id,text FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT 8').all(expression);
  }
  forget(id:string) {this.db.exec('BEGIN');try{this.db.prepare('DELETE FROM notes WHERE id=?').run(id);this.db.prepare('DELETE FROM notes_fts WHERE id=?').run(id);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}
  close() { this.db.close(); }
}
