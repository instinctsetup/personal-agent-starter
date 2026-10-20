/** Stage v3.6: structured tracing - spans per tool/race/plan step, run summaries, span trees, endpoints, chat commands. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-trace-"));
process.env.AGENT_STATUS_TICK_MS = "50";
delete process.env.APP_PASSWORD;

const { startSpan, endSpan, runSpan, spansForRun, recentRuns, spanTree } = await import("../src2/trace.js");
const { handleUserMessage } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");
const { buildApp } = await import("../src2/app.js");

test("span primitives: lifecycle, attrs merge, tree ordering", async () => {
  const root = startSpan("run-x", "plan:test", null, { a: 1 });
  const child = startSpan("run-x", "plan.step 1", root, { cmd: "inbox" });
  await new Promise((r) => setTimeout(r, 5));
  endSpan(child, "error", { error: "boom" });
  endSpan(root, "ok", { final: "done" });
  const spans = spansForRun("run-x");
  assert.equal(spans.length, 2);
  assert.equal(spans[0].name, "plan:test");
  assert.equal(spans[0].status, "ok");
  assert.equal(spans[0].attrs.a, 1);
  assert.equal(spans[0].attrs.final, "done"); // merged
  assert.equal(spans[1].status, "error");
  assert.equal(spans[1].attrs.error, "boom");
  assert.ok(spans[1].end_ts! >= spans[1].start_ts);
  const tree = spanTree("run-x");
  assert.deepEqual(tree.map((s) => [s.depth, s.name]), [[0, "plan:test"], [1, "plan.step 1"]]);
});

test("runSpan: ok and error paths record status and rethrow", async () => {
  assert.equal(await runSpan("run-y", "op", null, {}, async () => 42), 42);
  await assert.rejects(() => runSpan("run-y", "bad-op", null, {}, async () => { throw new Error("nope"); }), /nope/);
  const spans = spansForRun("run-y");
  assert.equal(spans.find((s) => s.name === "op")!.status, "ok");
  assert.equal(spans.find((s) => s.name === "bad-op")!.status, "error");
  assert.match(String(spans.find((s) => s.name === "bad-op")!.attrs.error), /nope/);
});

test("recentRuns: grouped summaries with durations, errors, tool names", async () => {
  const s1 = startSpan("run-z1", "jobs.hunt", null, {});
  endSpan(s1, "ok");
  const s2 = startSpan("run-z2", "mail.send", null, {});
  endSpan(s2, "error", { error: "smtp down" });
  const runs = recentRuns(5);
  const z2 = runs.find((r) => r.run_id === "run-z2")!;
  assert.equal(z2.errors, 1);
  assert.deepEqual(z2.tools, ["mail.send"]);
  const z1 = runs.find((r) => r.run_id === "run-z1")!;
  assert.equal(z1.errors, 0);
});

test("e2e: a real command leaves a span trail; 'traces' and 'trace <id>' render it", async () => {
  let runId = "";
  const off = onEvent((e) => { if (e.kind === "tool_call") runId = e.run_id; });
  try { await handleUserMessage("applications"); } finally { off(); }
  assert.ok(runId, "a tool ran");
  const spans = spansForRun(runId);
  assert.ok(spans.some((s) => s.name === "tracker.list" && s.status === "ok"), JSON.stringify(spans.map((s) => s.name)));

  const texts: string[] = [];
  const off2 = onEvent((e) => { if (e.kind === "text" && e.role === "agent") texts.push(e.text); });
  await handleUserMessage("traces");
  await handleUserMessage(`trace ${runId}`);
  off2();
  const joined = texts.join("\n");
  assert.match(joined, /Recent runs:/);
  assert.match(joined, new RegExp(`✓ tracker\\.list \\(\\d`));
});

test("endpoints: /api/traces lists runs, /api/traces/:id returns the tree", async () => {
  const app = await buildApp();
  const s1 = startSpan("run-http", "web.search", null, { input: { query: "x" } });
  endSpan(s1, "ok");
  const list = await app.inject({ method: "GET", url: "/api/traces" });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().runs.some((r: any) => r.run_id === "run-http"));
  const one = await app.inject({ method: "GET", url: "/api/traces/run-http" });
  assert.equal(one.json().spans[0].name, "web.search");
  await app.close();
});
