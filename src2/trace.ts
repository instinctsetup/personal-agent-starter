/** Structured tracing: every run is a tree of spans (tool calls, model races, plan steps).
 *  Queryable in SQLite, served over /api/traces, rendered on the overview board. */
import { randomBytes } from "node:crypto";
import { db } from "./db.js";

db.exec(`CREATE TABLE IF NOT EXISTS spans (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER,
  status TEXT NOT NULL DEFAULT 'running',   -- running | ok | error
  attrs TEXT NOT NULL DEFAULT '{}'          -- JSON: tool input, winner label, error, step index...
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_spans_run ON spans(run_id, start_ts)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_spans_start ON spans(start_ts)`);

export type Span = {
  id: string; run_id: string; parent_id: string | null; name: string;
  start_ts: number; end_ts: number | null; status: string; attrs: Record<string, unknown>;
};

const toSpan = (r: any): Span => ({ ...r, attrs: JSON.parse(r.attrs || "{}") });

export function startSpan(runId: string, name: string, parentId: string | null = null, attrs: Record<string, unknown> = {}): string {
  const id = randomBytes(6).toString("hex");
  db.prepare("INSERT INTO spans (id, run_id, parent_id, name, start_ts, attrs) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, runId, parentId, name, Date.now(), JSON.stringify(attrs).slice(0, 4000));
  return id;
}

export function endSpan(id: string, status: "ok" | "error" = "ok", attrs: Record<string, unknown> = {}) {
  const cur = db.prepare("SELECT attrs FROM spans WHERE id = ?").get(id) as any;
  if (!cur) return;
  const merged = { ...JSON.parse(cur.attrs || "{}"), ...attrs };
  db.prepare("UPDATE spans SET end_ts = ?, status = ?, attrs = ? WHERE id = ?")
    .run(Date.now(), status, JSON.stringify(merged).slice(0, 4000), id);
}

/** Wrap an operation in a span. */
export async function runSpan<T>(runId: string, name: string, parentId: string | null, attrs: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const id = startSpan(runId, name, parentId, attrs);
  try {
    const out = await fn();
    endSpan(id, "ok");
    return out;
  } catch (e: any) {
    endSpan(id, "error", { error: String(e?.message || e).slice(0, 500) });
    throw e;
  }
}

export function spansForRun(runId: string): Span[] {
  return (db.prepare("SELECT * FROM spans WHERE run_id = ? ORDER BY start_ts").all(runId) as any[]).map(toSpan);
}

export type RunSummary = {
  run_id: string; first_ts: number; last_ts: number; duration_ms: number;
  spans: number; errors: number; tools: string[];
};

export function recentRuns(limit = 20): RunSummary[] {
  const rows = db.prepare(`
    SELECT run_id, MIN(start_ts) AS first_ts, MAX(COALESCE(end_ts, start_ts)) AS last_ts,
           COUNT(*) AS spans, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
           GROUP_CONCAT(name, '||') AS names
    FROM spans GROUP BY run_id ORDER BY first_ts DESC LIMIT ?`).all(limit) as any[];
  return rows.map((r) => ({
    run_id: r.run_id, first_ts: r.first_ts, last_ts: r.last_ts,
    duration_ms: r.last_ts - r.first_ts, spans: r.spans, errors: r.errors,
    tools: String(r.names || "").split("||").filter(Boolean),
  }));
}

/** A span tree for display. */
export function spanTree(runId: string): (Span & { depth: number })[] {
  const spans = spansForRun(runId);
  const byParent = new Map<string | null, Span[]>();
  for (const s of spans) {
    const key = s.parent_id && spans.some((p) => p.id === s.parent_id) ? s.parent_id : null;
    byParent.set(key, [...(byParent.get(key) || []), s]);
  }
  const out: (Span & { depth: number })[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const s of byParent.get(parent) || []) {
      out.push({ ...s, depth });
      walk(s.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
