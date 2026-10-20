/** Skills manifest covers every tool the agent actually calls. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-manifest-"));

test("every toolCall name in agent2 is registered in the skills manifest", async () => {
  const { getTool } = await import("../src2/skills.js");
  const src = readFileSync(new URL("../src2/agent2.ts", import.meta.url), "utf8");
  const used = [...new Set([...src.matchAll(/toolCall\(runId, "([^"]+)"/g)].map((m) => m[1]))].sort();
  const missing = used.filter((name) => !getTool(name));
  assert.deepEqual(missing, [], `unregistered tools: ${missing.join(", ")}`);
});

test("fs.cleanup is daily-capped and identity-risk tools still require approval", async () => {
  const { getTool } = await import("../src2/skills.js");
  assert.equal(getTool("fs.cleanup")?.capAction, "cleanup");
  assert.equal(getTool("jobs.apply")?.approval, true);
  assert.equal(getTool("system.info")?.risk, "read");
});
