/** Tier 3.1: durable per-channel conversation state. The in-memory maps in agent2
 *  (hunt shortlists, router clarify questions, form fact questions) vanish on
 *  restart; this table is their persistent mirror so a restart no longer eats an
 *  in-flight conversation. One row per (channel, kind) - the map is the runtime
 *  truth, the table is the restart backup. */
import { db } from "./db.js";

db.exec(`CREATE TABLE IF NOT EXISTS conversation_state (
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,        -- hunt | clarify | facts
  payload TEXT NOT NULL,     -- JSON
  expires INTEGER NOT NULL,
  PRIMARY KEY (channel, kind)
)`);

export type ConvStateRow = { channel: string; kind: string; payload: any; expires: number };

export function saveState(channel: string, kind: string, payload: unknown, expires: number): void {
  try {
    db.prepare("INSERT INTO conversation_state (channel, kind, payload, expires) VALUES (?, ?, ?, ?) ON CONFLICT (channel, kind) DO UPDATE SET payload = excluded.payload, expires = excluded.expires")
      .run(channel, kind, JSON.stringify(payload), expires);
  } catch { /* persistence must never break a chat turn */ }
}

export function clearState(channel: string, kind: string): void {
  try { db.prepare("DELETE FROM conversation_state WHERE channel = ? AND kind = ?").run(channel, kind); } catch { /* best effort */ }
}

export function loadStates(): ConvStateRow[] {
  try {
    const rows = db.prepare("SELECT channel, kind, payload, expires FROM conversation_state").all() as { channel: string; kind: string; payload: string; expires: number }[];
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  } catch { return []; }
}
