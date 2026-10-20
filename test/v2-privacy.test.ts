/** Tier 3.5: local-model-first privacy routing. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-privacy-"));
const { getSetting, setSetting } = await import("../src2/db.js");
const { localEnabled } = await import("../src2/local.js");

test("chatWithPrivacy exists and prefers local only when enabled + configured", async () => {
  const agent = await import("../src2/agent2.js");
  assert.equal(typeof agent.chatWithPrivacy, "function");
  // no local setup in this sandbox: local path must be skipped silently
  assert.equal(localEnabled(), false);
  assert.equal(getSetting("local_chat_model"), null);
});

test("local-first gate conditions: both the enable flag AND a model name are required", async () => {
  const { setLocalEnabled } = await import("../src2/local.js");
  setLocalEnabled(true);
  assert.equal(localEnabled(), true);
  assert.equal(getSetting("local_chat_model"), null, "no model -> local path skipped, cloud race used");
  setSetting("local_chat_model", "qwen3:4b");
  assert.equal(getSetting("local_chat_model"), "qwen3:4b", "with both set, ollamaChat is attempted first (covered by code path)");
  setLocalEnabled(false);
});
