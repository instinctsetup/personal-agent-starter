/** Tier 3.2: per-provider daily quota ledger. Every model-race attempt spends
 *  one upstream request even when a faster racer wins, so attempts - not wins -
 *  are the honest count. Caps are best-known free-tier defaults the user can
 *  override with `cap quota <provider> <N>`; unknown caps show the raw count. */
import { db, getSetting, setSetting } from "./db.js";

db.exec(`CREATE TABLE IF NOT EXISTS quota_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  provider TEXT NOT NULL,         -- gemini | groq | openrouter | cerebras | github-models | local | gemini-web | mock
  model TEXT NOT NULL,
  won INTEGER NOT NULL DEFAULT 0  -- 1 when this attempt produced the answer used
)`);

/** Split a racer label ("groq/llama-3.3-70b", "gemini-2.5-flash", "gemini-web (experimental)") into provider + model. */
export function providerOf(label: string, configuredProvider: string): { provider: string; model: string } {
  if (label.includes("/")) {
    const [provider, ...rest] = label.split("/");
    return { provider, model: rest.join("/") };
  }
  if (label.startsWith("gemini-web")) return { provider: "gemini-web", model: "gemini-web" };
  return { provider: configuredProvider, model: label };
}

export function recordAttempt(provider: string, model: string, won: boolean): number | null {
  try {
    const r = db.prepare("INSERT INTO quota_ledger (ts, provider, model, won) VALUES (?, ?, ?, ?)").run(Date.now(), provider, model, won ? 1 : 0);
    return Number(r.lastInsertRowid);
  } catch { /* bookkeeping must never break a chat turn */ return null; }
}

/** Credit the win to the attempt row - one request, one row, never double-counted. */
export function markWon(id: number | null): void {
  if (id == null) return;
  try { db.prepare("UPDATE quota_ledger SET won = 1 WHERE id = ?").run(id); } catch { /* best effort */ }
}

/** Best-known free-tier daily request caps. Overridable per provider via `cap quota <provider> <N>`. */
export const DEFAULT_QUOTAS: Record<string, number | null> = {
  gemini: 250,
  groq: 1000,
  openrouter: 50,
  cerebras: 1000,
  "github-models": 50,
  local: null,        // unlimited - his own GPU
  "gemini-web": null, // unknown web quota
  mock: null,
};

export function quotaCap(provider: string): number | null {
  const v = getSetting(`quota_cap_${provider}`);
  if (v) { const n = Number(v); if (Number.isFinite(n) && n >= 0) return Math.floor(n); }
  return DEFAULT_QUOTAS[provider] ?? null;
}

export function setQuotaCap(provider: string, n: number): void {
  setSetting(`quota_cap_${provider}`, String(Math.max(0, Math.floor(n))));
}

/** 7-day retention: every model-race attempt inserts a row, forever, on a 24/7 daemon.
 * Sweep stale rows at boot (same place the OneDrive warning runs). */
export function pruneQuotaLedger(now = Date.now()): void {
  try { db.prepare("DELETE FROM quota_ledger WHERE ts < ?").run(now - 7 * 24 * 60 * 60 * 1000); } catch { /* best effort */ }
}

function dayStart(ts = Date.now()): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export type QuotaRow = { provider: string; used: number; wins: number; cap: number | null };

export function quotaToday(now = Date.now()): QuotaRow[] {
  const rows = db.prepare(
    "SELECT provider, COUNT(*) AS used, SUM(won) AS wins FROM quota_ledger WHERE ts >= ? GROUP BY provider ORDER BY used DESC",
  ).all(dayStart(now)) as { provider: string; used: number; wins: number }[];
  return rows.map((r) => ({ ...r, cap: quotaCap(r.provider) }));
}

export function formatQuota(rows: QuotaRow[]): string {
  if (!rows.length) return "No model calls yet today.";
  return rows.map((r) => {
    const cap = r.cap == null ? "" : `/${r.cap}`;
    const warn = r.cap != null && r.used >= r.cap * 0.8 ? " <- nearly there" : "";
    return `- ${r.provider}: ${r.used}${cap} requests today (${r.wins} answered)${warn}`;
  }).join("\n");
}
