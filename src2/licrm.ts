/** Tier 2.6: LinkedIn mini-CRM - turns one-off DMs/invites into a pipeline.
 *  Records every approval-passed send, sets a follow-up reminder through the
 *  existing scheduler, and tracks replied/followed-up status. The follow-up
 *  itself still goes through the normal (capped, approval-gated) message flow. */
import { db } from "./db.js";

db.exec(`CREATE TABLE IF NOT EXISTS linkedin_outreach (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,               -- message | invite
  url TEXT NOT NULL,
  slug TEXT NOT NULL,               -- linkedin.com/in/<slug> -> <slug>, lowercased
  note TEXT,                        -- first chars of what was sent
  status TEXT NOT NULL DEFAULT 'sent',  -- sent | replied | followed_up
  follow_up_due INTEGER,            -- ms epoch; NULL once replied/followed up
  job_id TEXT                       -- scheduler reminder job, if any
)`);

export type OutreachRow = {
  id: number; ts: number; kind: string; url: string; slug: string;
  note: string | null; status: string; follow_up_due: number | null; job_id: string | null;
};

export function slugOf(url: string): string {
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return (m ? m[1] : url).toLowerCase().replace(/\/+$/, "");
}

export function recordOutreach(kind: "message" | "invite", url: string, note: string, followUpDays = 3): OutreachRow {
  const due = Date.now() + followUpDays * 24 * 60 * 60 * 1000;
  const r = db.prepare(
    "INSERT INTO linkedin_outreach (ts, kind, url, slug, note, status, follow_up_due) VALUES (?, ?, ?, ?, ?, 'sent', ?)",
  ).run(Date.now(), kind, url, slugOf(url), note.slice(0, 200) || null, due);
  return db.prepare("SELECT * FROM linkedin_outreach WHERE id = ?").get(r.lastInsertRowid) as OutreachRow;
}

export function setFollowUpJob(outreachId: number, jobId: string): void {
  db.prepare("UPDATE linkedin_outreach SET job_id = ? WHERE id = ?").run(jobId, outreachId);
}

function findBySlug(slugOrUrl: string): OutreachRow | undefined {
  const slug = slugOf(slugOrUrl);
  return db.prepare("SELECT * FROM linkedin_outreach WHERE slug = ? ORDER BY id DESC LIMIT 1").get(slug) as OutreachRow | undefined;
}

/** They answered - pipeline stage done, no follow-up needed. */
export function markReplied(slugOrUrl: string): OutreachRow | null {
  const row = findBySlug(slugOrUrl);
  if (!row) return null;
  db.prepare("UPDATE linkedin_outreach SET status = 'replied', follow_up_due = NULL WHERE id = ?").run(row.id);
  return { ...row, status: "replied", follow_up_due: null };
}

/** He sent the follow-up himself - stop nagging. */
export function markFollowedUp(slugOrUrl: string): OutreachRow | null {
  const row = findBySlug(slugOrUrl);
  if (!row) return null;
  db.prepare("UPDATE linkedin_outreach SET status = 'followed_up', follow_up_due = NULL WHERE id = ?").run(row.id);
  return { ...row, status: "followed_up", follow_up_due: null };
}

export function listOutreach(limit = 20): OutreachRow[] {
  return db.prepare("SELECT * FROM linkedin_outreach ORDER BY id DESC LIMIT ?").all(limit) as OutreachRow[];
}

export function dueFollowUps(now = Date.now()): OutreachRow[] {
  return db.prepare("SELECT * FROM linkedin_outreach WHERE follow_up_due IS NOT NULL AND follow_up_due <= ? AND status = 'sent' ORDER BY follow_up_due").all(now) as OutreachRow[];
}

export function formatOutreach(rows: OutreachRow[]): string {
  if (!rows.length) return "";
  return rows.map((r) => {
    const age = Math.floor((Date.now() - r.ts) / 86400000);
    const due = r.follow_up_due ? (r.follow_up_due <= Date.now() ? "follow-up DUE" : `follow-up ${new Date(r.follow_up_due).toLocaleDateString()}`) : "no follow-up pending";
    return `- ${r.slug} (${r.kind}, ${age === 0 ? "today" : `${age}d ago`}): ${r.status}, ${due}`;
  }).join("\n");
}
