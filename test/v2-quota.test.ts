/** Tier 3.2: per-provider quota ledger. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-quota-"));
const quota = await import("../src2/quota.js");

test("providerOf splits labels", () => {
  assert.deepEqual(quota.providerOf("groq/llama-3.3-70b", "gemini"), { provider: "groq", model: "llama-3.3-70b" });
  assert.deepEqual(quota.providerOf("gemini-2.5-flash", "gemini"), { provider: "gemini", model: "gemini-2.5-flash" });
  assert.deepEqual(quota.providerOf("gemini-web (experimental)", "gemini"), { provider: "gemini-web", model: "gemini-web" });
});

test("attempts count once; markWon credits the same row", () => {
  const id = quota.recordAttempt("openrouter", "llama-free", false);
  quota.recordAttempt("groq", "llama-3.3-70b", false);
  quota.markWon(id);
  const rows = quota.quotaToday();
  const or = rows.find((r) => r.provider === "openrouter")!;
  assert.equal(or.used, 1, "one request, one row");
  assert.equal(or.wins, 1);
  assert.equal(or.cap, 50, "OpenRouter default cap");
});

test("caps: defaults, override, unknown", () => {
  assert.equal(quota.quotaCap("gemini"), 250);
  assert.equal(quota.quotaCap("local"), null);
  quota.setQuotaCap("groq", 500);
  assert.equal(quota.quotaCap("groq"), 500);
});

test("formatQuota shows used/cap and near-cap warning", () => {
  quota.setQuotaCap("warnme", 1);
  quota.recordAttempt("warnme", "m", false);
  const text = quota.formatQuota(quota.quotaToday());
  assert.match(text, /openrouter: 1\/50 requests today \(1 answered\)/);
  assert.match(text, /warnme: 1\/1 .* nearly there/);
});
