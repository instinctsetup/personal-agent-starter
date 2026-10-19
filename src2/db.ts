/** SQLite storage for v2: WAL mode, one db file, all app state. */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const DATA_DIR = process.env.AGENT_DATA_DIR || join(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(join(DATA_DIR, "agent-v2.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  role TEXT NOT NULL,               -- user | agent | system
  kind TEXT NOT NULL DEFAULT 'text',-- text | tool_call | approval | status | error
  body TEXT NOT NULL,               -- JSON payload
  run_id TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  action TEXT NOT NULL,             -- send_email | submit_application | shell | git_push | signup
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,            -- JSON, editable by user before approval
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | expired
  resolved_ts INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vault (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,            -- unstop | wellfound | gmail | ...
  username TEXT NOT NULL,
  secret_enc TEXT NOT NULL,         -- AES-256-GCM: iv.tag.ciphertext (base64)
  created_ts INTEGER NOT NULL,
  UNIQUE(service, username)
);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  company TEXT NOT NULL,
  role TEXT,
  portal TEXT,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'Applied',   -- Applied | Cold Mailed | Replied | Rejected | Scam Flagged
  notes TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  spec TEXT NOT NULL,               -- JSON: {kind, interval_min | cron, prompt}
  next_ts INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS signups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  site TEXT NOT NULL,
  url TEXT,
  method TEXT NOT NULL,             -- google_sso | email_password
  username TEXT,
  status TEXT NOT NULL DEFAULT 'completed'  -- completed | pending_verification | failed
);
`);

export function getSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
  return row ? row.value : null;
}
export function setSetting(key: string, value: string) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
