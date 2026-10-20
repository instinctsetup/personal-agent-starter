/** Stage v3.5: tool/skill registry - typed schemas, gate (schema + caps), manifest, chat command, new race providers. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-skills-"));
process.env.AGENT_STATUS_TICK_MS = "50";
delete process.env.APP_PASSWORD;

const { gateTool, validateArgs, getTool, skillManifest } = await import("../src2/skills.js");
const { setCap } = await import("../src2/caps.js");
const { handleUserMessage, buildRacers } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");
const { setSetting } = await import("../src2/db.js");
const { buildApp } = await import("../src2/app.js");

test("schema validation: missing required, wrong types, bad URLs", () => {
  const hunt = getTool("jobs.hunt")!;
  assert.equal(validateArgs(hunt, { query: "react internships" }), null);
  assert.match(validateArgs(hunt, {})!, /missing required argument "query"/);
  assert.match(validateArgs(hunt, { query: 42 })!, /must be a string/);
  const apply = getTool("jobs.apply")!;
  assert.equal(validateArgs(apply, { url: "https://unstop.com/jobs/1" }), null);
  assert.match(validateArgs(apply, { url: "not-a-url" })!, /must be an http\(s\) URL/);
});

test("gate: caps block a capped tool before it runs (defense in depth behind the flow-level check)", () => {
  setCap("apply", 0);
  const g = gateTool("jobs.apply", { url: "https://x.example/job" });
  assert.equal(g.allowed, false);
  if (!g.allowed) assert.match(g.reason, /daily cap for apply reached/);
  setCap("apply", 10);
  assert.equal(gateTool("jobs.apply", { url: "https://x.example/job" }).allowed, true);
  // uncapped read tools are always allowed
  assert.equal(gateTool("jobs.hunt", { query: "x" }).allowed, true);
  // unknown tools pass through (back-compat for unregistered internals)
  assert.equal(gateTool("totally.unknown", {}).allowed, true);
});

test("manifest: every registered tool has description, risk tier, and honest gate flags", () => {
  const m = skillManifest();
  assert.ok(m.length >= 15);
  for (const t of m) {
    assert.ok(t.description.length > 10, `${t.name} needs a real description`);
    assert.ok(["read", "write", "identity", "money"].includes(t.risk));
  }
  const send = m.find((t) => t.name === "mail.send")!;
  assert.equal(send.risk, "identity");
  assert.equal(send.approval, true);
  assert.equal(send.cap, "send_mail");
  // nothing is secretly uncapped: every identity-risk tool carries an approval gate
  for (const t of m.filter((x) => x.risk === "identity" || x.risk === "money")) {
    assert.equal(t.approval, true, `${t.name} is ${t.risk}-risk but has no approval gate`);
  }
});

test("/api/skills serves the manifest", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/skills" });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().tools.some((t: any) => t.name === "jobs.hunt"));
  await app.close();
});

test("chat: 'skills' lists tools with risk + gates", async () => {
  const evs: any[] = [];
  const off = onEvent((e) => evs.push(e));
  try { await handleUserMessage("skills"); } finally { off(); }
  const out = evs.filter((e) => e.kind === "text" && e.role === "agent").map((e) => e.text).join("\n");
  assert.match(out, /registered tools/);
  assert.match(out, /mail\.send \(identity, approval-gated, capped\/day\)/);
});

test("race: cerebras + github-models keys each add a racer with the right endpoint", () => {
  const base = buildRacers([{ role: "user", content: "hi" }]).map((r) => r.label);
  assert.ok(!base.some((l) => l.startsWith("cerebras/")), "no key -> no racer");
  setSetting("cerebras_api_key", "cb-test");
  setSetting("github_models_key", "ghp-test");
  const after = buildRacers([{ role: "user", content: "hi" }]).map((r) => r.label);
  assert.ok(after.includes("cerebras/llama-3.3-70b"));
  assert.ok(after.includes("github-models/gpt-4o-mini"));
});
