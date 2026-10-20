/** Durable multi-step plans: decompose a goal into checkpointed steps, execute with
 *  retries + model-assisted self-correction, survive restarts, resume on request. */
import { randomBytes } from "node:crypto";
import { db } from "./db.js";

db.exec(`CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  steps TEXT NOT NULL,              -- JSON PlanStep[]
  status TEXT NOT NULL,             -- running | done | paused | failed | cancelled
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL
)`);

export type PlanStep = { cmd: string; status: "pending" | "done" | "failed" | "skipped"; error?: string; attempts: number };
export type Plan = { id: string; goal: string; steps: PlanStep[]; status: string; created_ts: number; updated_ts: number };

function rowToPlan(r: any): Plan { return { ...r, steps: JSON.parse(r.steps) }; }

export function createPlan(goal: string, cmds: string[]): Plan {
  const p: Plan = {
    id: randomBytes(4).toString("hex"),
    goal,
    steps: cmds.map((cmd) => ({ cmd, status: "pending" as const, attempts: 0 })),
    status: "running",
    created_ts: Date.now(),
    updated_ts: Date.now(),
  };
  db.prepare("INSERT INTO plans (id, goal, steps, status, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?)")
    .run(p.id, p.goal, JSON.stringify(p.steps), p.status, p.created_ts, p.updated_ts);
  return p;
}

export function getPlan(id: string): Plan | null {
  const r = db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as any;
  return r ? rowToPlan(r) : null;
}

export function listPlans(limit = 10): Plan[] {
  return (db.prepare("SELECT * FROM plans ORDER BY created_ts DESC LIMIT ?").all(limit) as any[]).map(rowToPlan);
}

function save(p: Plan) {
  p.updated_ts = Date.now();
  db.prepare("UPDATE plans SET steps = ?, status = ?, updated_ts = ? WHERE id = ?")
    .run(JSON.stringify(p.steps), p.status, p.updated_ts, p.id);
}

export function cancelPlan(id: string): Plan | null {
  const p = getPlan(id);
  if (!p || p.status === "done") return p;
  p.status = "cancelled";
  for (const s of p.steps) if (s.status === "pending") s.status = "skipped";
  save(p);
  return p;
}

export type StepResult = { ok: boolean; error?: string; permanent?: boolean };
export type Executor = (cmd: string, stepIndex: number) => Promise<StepResult>;
/** Model-assisted self-correction: given the failed step, return ONE alternative command, or null to give up. */
export type Fixer = (goal: string, step: PlanStep) => Promise<string | null>;
export type PlanHooks = { onStep?: (p: Plan, i: number, phase: "start" | "done" | "failed" | "retry" | "corrected") => void };

const MAX_ATTEMPTS = 2; // original + one retry; the model-assisted correction is a separate final shot

/** Execute (or resume) a plan. Completed steps are checkpoints - never re-run. */
export async function runPlan(p: Plan, exec: Executor, fixer?: Fixer, hooks: PlanHooks = {}): Promise<Plan> {
  if (p.status === "cancelled" || p.status === "done") return p;
  p.status = "running";
  save(p);
  for (let i = 0; i < p.steps.length; i++) {
    const s = p.steps[i];
    if (s.status === "done" || s.status === "skipped") continue;
    if (s.status === "failed") { s.attempts = 0; s.error = undefined; } // an explicit resume earns a fresh attempt budget
    hooks.onStep?.(p, i, "start");
    let res: StepResult = { ok: false, error: "not run" };
    for (s.attempts = s.attempts + 1; s.attempts <= MAX_ATTEMPTS; s.attempts++) {
      if (s.attempts > 1) hooks.onStep?.(p, i, "retry");
      try {
        res = await exec(s.cmd, i);
      } catch (e: any) {
        res = { ok: false, error: String(e?.message || e) };
      }
      if (res.ok || res.permanent) break; // a user rejection or a cap is final - never retry, never route around it
      s.error = res.error;
      save(p); // checkpoint the failure before any retry
    }
    if (!res.ok && !res.permanent && fixer) {
      try {
        const alt = await fixer(p.goal, s);
        if (alt && alt.trim() && alt.trim() !== s.cmd) {
          s.cmd = alt.trim();
          s.attempts++;
          hooks.onStep?.(p, i, "corrected");
          try {
            res = await exec(s.cmd, i);
          } catch (e: any) {
            res = { ok: false, error: String(e?.message || e) };
          }
          if (!res.ok) s.error = res.error;
        }
      } catch { /* a fixer failure must not kill the plan - the step simply stays failed */ }
    }
    s.status = res.ok ? "done" : "failed";
    if (!res.ok) s.error = res.error;
    save(p); // checkpoint after every step
    hooks.onStep?.(p, i, res.ok ? "done" : "failed");
    if (!res.ok) {
      p.status = "paused"; // stopped at the failed step; "resume plan <id>" continues
      save(p);
      return p;
    }
  }
  p.status = "done";
  save(p);
  return p;
}
