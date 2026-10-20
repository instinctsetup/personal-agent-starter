/** Folder watcher: "watch Downloads for new PDFs" pings the chat the moment a matching
 *  file lands. Read-only - any move/rename of the file is a separate approval-gated action.
 *  Watch registrations persist in data/watchers.json and are restored at daemon boot. */
import { watch, type FSWatcher, existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { emit, newRunId } from "./bus.js";
import { DATA_DIR } from "./db.js";

export type WatchSpec = { id: string; dir: string; ext: string | null };

const STORE = join(DATA_DIR, "watchers.json");
const active = new Map<string, { spec: WatchSpec; watcher: FSWatcher; seen: Set<string>; pending: Map<string, NodeJS.Timeout> }>();

function loadSpecs(): WatchSpec[] {
  try { return JSON.parse(readFileSync(STORE, "utf8")) as WatchSpec[]; } catch { return []; }
}

function saveSpecs(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STORE, JSON.stringify([...active.values()].map((a) => a.spec), null, 2), "utf8");
}

function announce(text: string): void {
  const runId = newRunId();
  emit({ ts: Date.now(), run_id: runId, kind: "text", role: "agent", text });
}

/** NTFS is case-insensitive: "C:\Users\You\Downloads" and "c:\users\you\downloads"
 * are the same folder - compare normalized so a retyped path can't spawn a duplicate
 * watcher or leave one un-stoppable. */
function normalizeDir(dir: string): string {
  const r = resolve(dir.trim());
  return process.platform === "win32" ? r.toLowerCase() : r;
}

export function startWatch(dir: string, ext: string | null = null): WatchSpec {
  if (!existsSync(dir)) throw new Error(`${dir} does not exist.`);
  const normalizedExt = ext ? (ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`) : null;
  const key = normalizeDir(dir);
  for (const a of active.values()) {
    if (normalizeDir(a.spec.dir) === key && a.spec.ext === normalizedExt) return a.spec; // already watching
  }
  const spec: WatchSpec = { id: `watch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, dir, ext: normalizedExt };
  // snapshot current contents so only genuinely NEW files announce
  const seen = new Set<string>();
  try { for (const name of readdirSync(dir)) seen.add(name); } catch { /* re-checked on events */ }
  const entry = { spec, watcher: null as unknown as FSWatcher, seen, pending: new Map<string, NodeJS.Timeout>() };
  entry.watcher = watch(dir, (_event, filename) => {
    if (!filename || entry.seen.has(filename)) return;
    if (normalizedExt && !filename.toLowerCase().endsWith(normalizedExt)) { entry.seen.add(filename); return; }
    // debounce: a download/copy streams events; announce once it settles
    const prev = entry.pending.get(filename);
    if (prev) clearTimeout(prev);
    entry.pending.set(filename, setTimeout(() => {
      entry.pending.delete(filename);
      entry.seen.add(filename);
      const full = join(dir, filename);
      try { if (!statSync(full).isFile()) return; } catch { return; } // vanished or a directory
      announce(`New file in ${dir}: ${filename}${normalizedExt ? "" : ""}`);
    }, 750));
  });
  entry.watcher.on("error", () => { /* a deleted/renamed folder kills the handle; the spec stays for restart */ });
  active.set(spec.id, entry);
  saveSpecs();
  return spec;
}

export function stopWatch(idOrDir: string): boolean {
  let key: string | null = null;
  try { key = normalizeDir(idOrDir); } catch { key = null; }
  for (const [id, a] of active) {
    if (id === idOrDir || (key !== null && normalizeDir(a.spec.dir) === key)) {
      for (const t of a.pending.values()) clearTimeout(t);
      a.watcher.close();
      active.delete(id);
      saveSpecs();
      return true;
    }
  }
  return false;
}

export function listWatchers(): WatchSpec[] {
  return [...active.values()].map((a) => a.spec);
}

/** Called once at daemon boot: resume every persisted watch. */
export function restoreWatchers(): number {
  let n = 0;
  for (const spec of loadSpecs()) {
    try { startWatch(spec.dir, spec.ext); n++; } catch { /* folder gone - drop it */ }
  }
  return n;
}

/** Test/development helper: drop everything. */
export function stopAllWatchers(): void {
  for (const id of [...active.keys()]) stopWatch(id);
}
