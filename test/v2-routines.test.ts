/** Tier 1: named routines. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-routines-"));
process.env.AGENT_STATUS_TICK_MS = "50";

const { handleUserMessage } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");
const { getRoutine, deleteRoutine } = await import("../src2/routines.js");

test("define, list, run and delete a routine", async () => {
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage("routine morning = note: woke up + laptop status").catch(() => {});
  assert.match(events.map((e) => e.text || "").join("\n"), /Routine "morning" saved with 2 step/);
  const r = getRoutine("morning");
  assert.ok(r);
  assert.deepEqual(r!.steps, ["note: woke up", "laptop status"]);

  events.length = 0;
  await handleUserMessage("run morning").catch(() => {});
  const out = events.map((e) => e.text || "").join("\n");
  assert.match(out, /Running routine "morning"/);
  assert.match(out, /Noted\./, "step 1 ran");
  assert.match(out, /RAM: /, "step 2 ran");
  assert.match(out, /Routine "morning" finished/);

  events.length = 0;
  await handleUserMessage("routines").catch(() => {});
  assert.match(events.map((e) => e.text || "").join("\n"), /morning: note: woke up \+ laptop status/);

  await handleUserMessage("delete routine morning").catch(() => {});
  assert.equal(getRoutine("morning"), undefined);
  off();
});

test("a routine cannot nest another routine", async () => {
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage("routine bad = run morning").catch(() => {});
  off();
  assert.match(events.map((e) => e.text || "").join("\n"), /can't run another routine/);
});

test("run <unknown> falls through instead of eating the message", async () => {
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage("run nonexistent").catch(() => {});
  off();
  const out = events.map((e) => e.text || "").join("\n");
  assert.ok(!/Running routine/.test(out), "unknown routine name is not treated as a run");
});
