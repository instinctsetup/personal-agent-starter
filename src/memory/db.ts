import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
export type Status = 'queued' | 'running' | 'waiting' | 'completed' | 'failed';
export class Memory {
  readonly db: DatabaseSync;
  constructor(path = 'agent_memory.db') {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id), goal TEXT NOT NULL, status TEXT NOT NULL, steps INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, task_id TEXT REFERENCES tasks(id), kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
    // A restart never replays an uncertain side effect automatically.
    this.db.prepare("UPDATE tasks SET status='waiting' WHERE status='running'").run();
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
  messages(id: string): Array<{role:'user'|'assistant';content:string}> { return this.db.prepare("SELECT body FROM events WHERE task_id=? AND kind='message' ORDER BY id").all(id).map(r => JSON.parse(String(r.body))); }
  step(id: string) { this.db.prepare('UPDATE tasks SET steps=steps+1 WHERE id=?').run(id); }
  close() { this.db.close(); }
}
