/** Durable memory: facts, preferences and session summaries the agent recalls across restarts.
 *  Injected into the router + chat prompts in a bounded block. Secrets are never stored. */
import { randomBytes } from "node:crypto";
import { db } from "./db.js";

db.exec(`CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,               -- fact | preference | summary
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user'  -- user | extracted | system
)`);

export type Memory = { id: string; ts: number; kind: string; text: string; source: string };

const SECRET_PATTERNS = [
  /password|passcode|passwd|pwd\b/i,
  /\b(?:\d[ -]?){13,19}\b/,                    // card numbers
  /\b\d{3}-\d{2}-\d{4}\b/,                     // SSN-like
  /\b\d{6}\b/,                                 // OTP-shaped standalone 6-digit
  /api[_ -]?key|secret|token|bearer/i,
  /cvv|cvc|expir/i,
  /\b(?:sk|pk|ghp|gho|xox[baprs])-[A-Za-z0-9-]{10,}/, // common API token shapes
];

/** True when the text looks like it carries a secret - those never become memories. */
export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

export function addMemory(kind: "fact" | "preference" | "summary" | "note", text: string, source = "user"): Memory | null {
  const clean = text.trim().replace(/\s+/g, " ");
  if (!clean || clean.length < 3) return null;
  if (looksSecret(clean)) return null;
  const m: Memory = { id: randomBytes(4).toString("hex"), ts: Date.now(), kind, text: clean.slice(0, 500), source };
  db.prepare("INSERT INTO memories (id, ts, kind, text, source) VALUES (?, ?, ?, ?, ?)").run(m.id, m.ts, m.kind, m.text, m.source);
  return m;
}

export function listMemories(limit = 50): Memory[] {
  return db.prepare("SELECT * FROM memories ORDER BY ts DESC LIMIT ?").all(limit) as Memory[];
}

export function forgetMemory(idOrFragment: string): number {
  const byId = db.prepare("DELETE FROM memories WHERE id = ?").run(idOrFragment).changes;
  if (byId) return byId;
  return db.prepare("DELETE FROM memories WHERE text LIKE ?").run(`%${idOrFragment}%`).changes;
}

export function forgetAll(): number {
  return db.prepare("DELETE FROM memories").run().changes;
}

/** The bounded block prepended to model prompts. Newest first, preferences before facts before summaries. */
export function memoryContext(maxChars = 1500): string {
  const rank = { preference: 0, fact: 1, summary: 2, note: 3 } as Record<string, number>;
  const rows = listMemories(60).sort((a, b) => rank[a.kind] - rank[b.kind] || b.ts - a.ts);
  const lines: string[] = [];
  let used = 0;
  for (const r of rows) {
    const line = `- (${r.kind}) ${r.text}`;
    if (used + line.length > maxChars) continue;
    lines.push(line);
    used += line.length;
  }
  return lines.length
    ? `What you remember about the user (durable, from earlier conversations - use it, don't re-ask it):\n${lines.join("\n")}`
    : "";
}
