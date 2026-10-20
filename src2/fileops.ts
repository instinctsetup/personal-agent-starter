/** Approval-gated file operations: batch rename and downloads cleanup.
 *  Every mutation goes through the undo ledger (data/undo-log.jsonl) so
 *  "undo last rename" / "undo last cleanup" can reverse it. Plans are always
 *  computed first and shown on an approval card before anything moves. */
import { readdirSync, renameSync, existsSync, mkdirSync, statSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { DATA_DIR } from "./db.js";

export type Move = { from: string; to: string };

const LEDGER = join(DATA_DIR, "undo-log.jsonl");

function ledgerAppend(kind: string, moves: Move[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(LEDGER, JSON.stringify({ ts: Date.now(), kind, moves }) + "\n", "utf8");
}

export function ledgerLast(kind?: string): { ts: number; kind: string; moves: Move[] } | null {
  if (!existsSync(LEDGER)) return null;
  const lines = readFileSync(LEDGER, "utf8").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (!kind || entry.kind === kind) return entry;
    } catch { /* skip corrupt line */ }
  }
  return null;
}

export type LedgerEntry = { ts: number; kind: string; moves: Move[] };

/** The last N ledger entries, newest first - the "what did I move/rename/delete?" view. */
export function ledgerList(limit = 10): LedgerEntry[] {
  if (!existsSync(LEDGER)) return [];
  const lines = readFileSync(LEDGER, "utf8").trim().split("\n").filter(Boolean);
  const out: LedgerEntry[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try { out.push(JSON.parse(lines[i])); } catch { /* skip corrupt line */ }
  }
  return out;
}

/** Reverse one specific ledger entry by timestamp (from the file-history view / Traces tab). */
export function undoEntry(ts: number): { reversed: number; skipped: number } {
  const entry = ledgerList(100).find((e) => e.ts === ts);
  if (!entry) throw new Error("That file operation is no longer in the ledger (already undone?).");
  let reversed = 0;
  let skipped = 0;
  const remaining: Move[] = [];
  for (const mv of [...entry.moves].reverse()) {
    if (!existsSync(mv.to) || existsSync(mv.from)) { remaining.push(mv); skipped++; continue; }
    mkdirSync(dirname(mv.from), { recursive: true });
    renameSync(mv.to, mv.from);
    reversed++;
  }
  const lines = readFileSync(LEDGER, "utf8").trim().split("\n").filter(Boolean);
  const idx = lines.findIndex((l) => { try { return JSON.parse(l).ts === ts; } catch { return false; } });
  if (idx >= 0) {
    if (remaining.length) lines[idx] = JSON.stringify({ ts: entry.ts, kind: entry.kind, moves: remaining });
    else lines.splice(idx, 1);
    writeFileSync(LEDGER, lines.length ? lines.join("\n") + "\n" : "", "utf8");
  }
  return { reversed, skipped };
}

/** Execute moves, refusing to clobber anything. Returns the moves actually applied. */
export function applyMoves(moves: Move[], kind: string): Move[] {
  const done: Move[] = [];
  for (const mv of moves) {
    if (!existsSync(mv.from)) continue; // vanished since the plan - skip
    if (existsSync(mv.to)) throw new Error(`Refusing to overwrite ${mv.to} - a file with that name already exists. Applied ${done.length}/${moves.length} move(s) before stopping.`);
    mkdirSync(dirname(mv.to), { recursive: true });
    renameSync(mv.from, mv.to);
    done.push(mv);
  }
  if (done.length) ledgerAppend(kind, done);
  return done;
}

/** Reverse the most recent ledger entry of a kind. */
export function undoLast(kind: string): { reversed: number; skipped: number } {
  const entry = ledgerLast(kind);
  if (!entry) throw new Error(`Nothing to undo - the ${kind} ledger is empty.`);
  let reversed = 0;
  let skipped = 0;
  const remaining: Move[] = [];
  for (const mv of [...entry.moves].reverse()) {
    if (!existsSync(mv.to) || existsSync(mv.from)) { remaining.push(mv); skipped++; continue; }
    mkdirSync(dirname(mv.from), { recursive: true });
    renameSync(mv.to, mv.from);
    reversed++;
  }
  // rewrite the ledger without the reversed entry (keep any moves that could not be reversed)
  const lines = existsSync(LEDGER) ? readFileSync(LEDGER, "utf8").trim().split("\n").filter(Boolean) : [];
  const idx = lines.map((l) => { try { return JSON.stringify(JSON.parse(l).moves) === JSON.stringify(entry.moves) && JSON.parse(l).kind === kind; } catch { return false; } }).lastIndexOf(true);
  if (idx >= 0) {
    if (remaining.length) lines[idx] = JSON.stringify({ ts: entry.ts, kind, moves: remaining });
    else lines.splice(idx, 1);
    writeFileSync(LEDGER, lines.length ? lines.join("\n") + "\n" : "", "utf8");
  }
  return { reversed, skipped };
}

/** Plan a batch rename: files in dir whose name contains `find` get it replaced with `replace`. */
export function planRename(dir: string, find: string, replace: string): Move[] {
  if (!find) throw new Error("Nothing to find - give me the text to replace in the filenames.");
  if (!existsSync(dir)) throw new Error(`${dir} does not exist.`);
  const moves: Move[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.includes(find)) continue;
    const full = join(dir, name);
    if (!statSync(full).isFile()) continue; // files only - never directories
    moves.push({ from: full, to: join(dir, name.split(find).join(replace)) });
  }
  return moves;
}

/** Plan a downloads cleanup: files older than olderThanDays move into _archive/YYYY-MM/. */
export function planDownloadsCleanup(downloadsDir: string, olderThanDays = 30, now = Date.now()): Move[] {
  if (!existsSync(downloadsDir)) throw new Error(`${downloadsDir} does not exist.`);
  const cutoff = now - olderThanDays * 86_400_000;
  const moves: Move[] = [];
  for (const name of readdirSync(downloadsDir)) {
    if (name === "_archive" || name.startsWith(".")) continue;
    const full = join(downloadsDir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (!st.isFile() || st.mtimeMs > cutoff) continue;
    const month = new Date(st.mtimeMs).toISOString().slice(0, 7); // YYYY-MM of the file's last write
    moves.push({ from: full, to: join(downloadsDir, "_archive", month, name) });
  }
  return moves;
}

export function downloadsDir(): string {
  return join(process.env.USERPROFILE || process.env.HOME || ".", "Downloads");
}

export function fmtMoves(moves: Move[], max = 15): string {
  const lines = moves.slice(0, max).map((m) => `- ${m.from}\n  -> ${m.to}`);
  if (moves.length > max) lines.push(`... and ${moves.length - max} more`);
  return lines.join("\n");
}
