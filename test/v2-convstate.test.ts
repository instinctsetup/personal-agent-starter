/** Tier 3.1: durable per-channel conversation state. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-convstate-"));
const cs = await import("../src2/convstate.js");

test("save/load/clear round-trip, one row per channel+kind", () => {
  cs.saveState("web", "hunt", { results: [{ url: "https://x/1", title: "T" }], expires: 999 }, 999);
  cs.saveState("web", "clarify", { question: "Which account?", original: "send mail" }, 999);
  cs.saveState("web", "hunt", { results: [{ url: "https://x/2", title: "T2" }], expires: 1000 }, 1000); // overwrite
  const rows = cs.loadStates();
  assert.equal(rows.length, 2, "upsert, not duplicate");
  assert.equal(rows.find((r) => r.kind === "hunt")!.payload.results[0].url, "https://x/2");
  cs.clearState("web", "hunt");
  assert.equal(cs.loadStates().length, 1);
});

test("per-channel isolation", () => {
  cs.saveState("telegram", "hunt", { results: [], expires: 1 }, 1);
  const rows = cs.loadStates();
  assert.ok(rows.some((r) => r.channel === "telegram"));
  assert.ok(rows.some((r) => r.channel === "web"));
  cs.clearState("telegram", "hunt");
  assert.ok(!cs.loadStates().some((r) => r.channel === "telegram"));
});
