/** Tier 1: notes & reminders. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-notes-"));
process.env.AGENT_STATUS_TICK_MS = "50";

const { handleUserMessage } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");
const { listMemories } = await import("../src2/memory.js");
const { listJobs, deleteJob } = await import("../src2/scheduler.js");

test("note: stores a note, 'notes' lists it, secrets are refused", async () => {
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage("note: ask recruiter about remote work").catch(() => {});
  await handleUserMessage("notes").catch(() => {});
  off();
  const out = events.map((e) => e.text || "").join("\n");
  assert.match(out, /Noted\. \(id /);
  assert.match(out, /ask recruiter about remote work/);
  const notes = listMemories(50).filter((m) => m.kind === "note");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].source, "user");

  const events2: any[] = [];
  const off2 = onEvent((e) => events2.push(e));
  await handleUserMessage("note: my password is hunter2").catch(() => {});
  off2();
  assert.match(events2.map((e) => e.text || "").join("\n"), /vault only/i);
  assert.equal(listMemories(50).filter((m) => m.kind === "note").length, 1, "secret-looking note not stored");
});

test("remind me in N minutes schedules a one-shot reminder job", async () => {
  const before = Date.now();
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage("remind me in 30 minutes to stretch").catch(() => {});
  off();
  const out = events.map((e) => e.text || "").join("\n");
  assert.match(out, /I'll remind you .*: "stretch"/);
  const jobs = listJobs().filter((j) => j.spec.command === "remind: stretch");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].spec.interval_min, null, "one-shot, not recurring");
  assert.ok(jobs[0].next_ts >= before + 29 * 60_000 && jobs[0].next_ts <= Date.now() + 31 * 60_000, "fires ~30 min from now");
  deleteJob(jobs[0].id);
});

test("remind me at 5pm converts to 24h and rolls to tomorrow when 5pm has passed", async () => {
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage("remind me at 5pm to follow up with the recruiter").catch(() => {});
  off();
  const jobs = listJobs().filter((j) => j.spec.command === "remind: follow up with the recruiter");
  assert.equal(jobs.length, 1);
  const d = new Date(jobs[0].next_ts);
  assert.equal(d.getHours(), 17);
  assert.equal(d.getMinutes(), 0);
  assert.ok(jobs[0].next_ts > Date.now(), "always in the future");
  deleteJob(jobs[0].id);
});

test("the fired reminder command speaks the reminder text", async () => {
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage("remind: call mom").catch(() => {});
  off();
  assert.match(events.map((e) => e.text || "").join("\n"), /Reminder: call mom/);
});
