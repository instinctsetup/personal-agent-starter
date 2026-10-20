/** Named routines: "routine morning = check mail + hunt AI internships + laptop status".
 *  One phrase replays the steps in order. Steps are ordinary chat commands, so every
 *  approval gate, cap and undo ledger inside them keeps working unchanged. Routines are
 *  schedulable through the normal scheduler ("at 08:00 run morning"). */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./db.js";

export type Routine = { name: string; steps: string[]; ts: number };

const STORE = join(DATA_DIR, "routines.json");

function load(): Routine[] {
  try { return JSON.parse(readFileSync(STORE, "utf8")) as Routine[]; } catch { return []; }
}

function save(routines: Routine[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STORE, JSON.stringify(routines, null, 2), "utf8");
}

export function setRoutine(name: string, steps: string[]): Routine {
  const clean = name.trim().toLowerCase();
  if (!/^[\w][\w -]{0,40}$/.test(clean)) throw new Error("Routine names: letters, numbers, spaces and dashes only.");
  if (!steps.length || steps.some((s) => !s.trim())) throw new Error("A routine needs at least one step.");
  if (steps.some((s) => /^\s*(run|routine)\s+/i.test(s))) throw new Error("A routine can't run another routine - keep steps as plain commands.");
  const routines = load().filter((r) => r.name !== clean);
  const routine: Routine = { name: clean, steps: steps.map((s) => s.trim()), ts: Date.now() };
  routines.push(routine);
  save(routines);
  return routine;
}

export function getRoutine(name: string): Routine | undefined {
  return load().find((r) => r.name === name.trim().toLowerCase());
}

export function listRoutines(): Routine[] {
  return load().sort((a, b) => b.ts - a.ts);
}

export function deleteRoutine(name: string): boolean {
  const before = load();
  const after = before.filter((r) => r.name !== name.trim().toLowerCase());
  if (after.length === before.length) return false;
  save(after);
  return true;
}
