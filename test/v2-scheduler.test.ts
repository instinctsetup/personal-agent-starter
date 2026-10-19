import test from "node:test";
import assert from "node:assert/strict";
process.env.AGENT_DATA_DIR = `/tmp/agent-v2-sched-${process.pid}`;
const { parseSchedule, addJob, listJobs, setJobEnabled, deleteJob } = await import("../src2/scheduler.js");

test("parseSchedule: every N minutes/hours", () => {
  const now = Date.now();
  const a = parseSchedule("every 15 minutes search AI internships", now)!;
  assert.equal(a.intervalMin, 15);
  assert.equal(a.command, "search AI internships");
  assert.ok(a.nextRun > now && a.nextRun <= now + 15 * 60_000 + 1000);
  const b = parseSchedule("every 2 hours tracker", now)!;
  assert.equal(b.intervalMin, 120);
});

test("parseSchedule: at HH:MM today or tomorrow", () => {
  const now = new Date(); now.setHours(10, 0, 0, 0);
  const later = parseSchedule("at 18:30 tracker", now.getTime())!;
  assert.equal(later.intervalMin, null);
  assert.equal(new Date(later.nextRun).getHours(), 18);
  const past = parseSchedule("at 06:00 tracker", now.getTime())!;
  assert.ok(new Date(past.nextRun).getDate() !== now.getDate() || past.nextRun > now.getTime());
});

test("parseSchedule: rejects junk", () => {
  assert.equal(parseSchedule("hello world"), null);
  assert.equal(parseSchedule("every 0 minutes x"), null);
});

test("jobs CRUD + enable/disable", () => {
  const j = addJob("tracker", Date.now() + 60000, 60);
  assert.ok(listJobs().some((x) => x.id === j.id));
  assert.ok(setJobEnabled(j.id, false));
  assert.equal(listJobs().find((x) => x.id === j.id)?.enabled, 0);
  assert.ok(setJobEnabled(j.id, true));
  assert.ok(deleteJob(j.id));
  assert.ok(!listJobs().some((x) => x.id === j.id));
});
