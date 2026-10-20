/** Per-action daily caps: a hard deterministic gate in front of wallet/identity-risk actions.
 *  Approval fatigue is real - "approved once" must never become "can do it ten times". */
import { db } from "./db.js";
import { getSetting, setSetting } from "./db.js";

db.exec(`CREATE TABLE IF NOT EXISTS action_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  action TEXT NOT NULL,             -- send_mail | apply | linkedin_message | linkedin_invite
  detail TEXT
)`);

export const DEFAULT_CAPS: Record<string, number> = {
  send_mail: 10,
  apply: 10,
  linkedin_message: 5,
  linkedin_invite: 5,
  cleanup: 1,
};

export function capOf(action: string): number {
  const v = getSetting(`cap_${action}`);
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : (DEFAULT_CAPS[action] ?? 0);
}

export function setCap(action: string, n: number) {
  setSetting(`cap_${action}`, String(Math.max(0, Math.floor(n))));
}

function dayStart(ts = Date.now()): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function usedToday(action: string): number {
  const r = db.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE action = ? AND ts >= ?").get(action, dayStart()) as any;
  return r.n as number;
}

export function checkCap(action: string): { allowed: boolean; used: number; cap: number } {
  const cap = capOf(action);
  const used = usedToday(action);
  return { allowed: used < cap, used, cap };
}

/** Record one executed action. Call ONLY after the action really happened (mail sent, application submitted). */
export function recordAction(action: string, detail = "") {
  db.prepare("INSERT INTO action_ledger (ts, action, detail) VALUES (?, ?, ?)").run(Date.now(), action, detail);
}

export function capStatus(): { action: string; used: number; cap: number }[] {
  return Object.keys(DEFAULT_CAPS).map((action) => ({ action, ...checkCap(action) }));
}
