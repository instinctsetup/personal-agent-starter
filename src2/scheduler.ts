/** Recurring + one-shot jobs persisted in SQLite; a 30s tick fires due jobs as chat commands. */
import { db } from "./db.js";
import { emit } from "./bus.js";

export type JobSpec = { command: string; interval_min: number | null };
export type Job = { id: string; spec: JobSpec; next_ts: number; enabled: number; last_run?: number | null };

// ensure optional last_run column
try { db.exec("ALTER TABLE jobs ADD COLUMN last_run INTEGER"); } catch { /* exists */ }

function rowToJob(r: any): Job { return { ...r, spec: JSON.parse(r.spec) }; }

export function addJob(command: string, nextRun: number, intervalMin: number | null): Job {
  const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare("INSERT INTO jobs(id, spec, next_ts, enabled) VALUES (?,?,?,1)")
    .run(id, JSON.stringify({ command, interval_min: intervalMin } satisfies JobSpec), nextRun);
  return getJob(id)!;
}
export function getJob(id: string): Job | undefined {
  const r = db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as any;
  return r ? rowToJob(r) : undefined;
}
export function listJobs(): Job[] {
  return (db.prepare("SELECT * FROM jobs ORDER BY next_ts ASC").all() as any[]).map(rowToJob);
}
export function setJobEnabled(id: string, enabled: boolean): boolean {
  return db.prepare("UPDATE jobs SET enabled=? WHERE id=?").run(enabled ? 1 : 0, id).changes > 0;
}
export function deleteJob(id: string): boolean {
  return db.prepare("DELETE FROM jobs WHERE id=?").run(id).changes > 0;
}

/** "every 45 minutes ..." / "every 2 hours ..." / "at 18:30 ..." -> schedule parts */
export function parseSchedule(input: string, now = Date.now()): { command: string; intervalMin: number | null; nextRun: number } | null {
  let m = input.match(/^every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\s+(.+)$/i);
  if (m) {
    const n = Number(m[1]);
    const intervalMin = /h/i.test(m[2][0]) ? n * 60 : n;
    if (intervalMin < 1) return null;
    return { command: m[3].trim(), intervalMin, nextRun: now + intervalMin * 60_000 };
  }
  m = input.match(/^at\s+(\d{1,2}):(\d{2})\s+(.+)$/i);
  if (m) {
    const d = new Date(now);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return { command: m[3].trim(), intervalMin: null, nextRun: d.getTime() };
  }
  return null;
}

let timer: NodeJS.Timeout | null = null;
/** Start the 30s tick. `runCommand` executes the job's chat command (injected to avoid a circular import). */
export function startScheduler(runCommand: (command: string) => Promise<void>): void {
  if (timer) return;
  timer = setInterval(async () => {
    const due = (db.prepare("SELECT * FROM jobs WHERE enabled=1 AND next_ts<=?").all(Date.now()) as any[]).map(rowToJob);
    for (const job of due) {
      db.prepare("UPDATE jobs SET last_run=?, next_ts=? WHERE id=?")
        .run(Date.now(), job.spec.interval_min ? Date.now() + job.spec.interval_min * 60_000 : Number.MAX_SAFE_INTEGER, job.id);
      emit({ ts: Date.now(), run_id: `sched-${job.id}-${Date.now()}`, kind: "status", text: `Scheduled run: ${job.spec.command}` });
      await runCommand(job.spec.command).catch(() => {});
    }
  }, 30_000);
  timer.unref();
}
export function stopScheduler(): void { if (timer) clearInterval(timer); timer = null; }
