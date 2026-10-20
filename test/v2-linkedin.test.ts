/** Stage 5: LinkedIn message/invite routing, risk gate, approval gate, daily caps + pacing. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-linkedin-"));
process.env.AGENT_STATUS_TICK_MS = "50";
process.env.AGENT_CHAT_DEADLINE_MS = "4000";

const { handleUserMessage, parseLinkedinAsk } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");
const { resolveApproval } = await import("../src2/approvals.js");
const { setSetting } = await import("../src2/db.js");
const { LinkedInTools, LinkedInStopped } = await import("../src/tools/linkedin.js");
const { Store } = await import("../src/config.js");

const texts = (evs: any[]) => evs.filter((e) => e.kind === "text" && e.role !== "user").map((e) => e.text).join("\n");

async function runAndGrabApproval(text: string, timeoutMs = 5000) {
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  const done = handleUserMessage(text).catch(() => {});
  const start = Date.now();
  let card: any;
  while (Date.now() - start < timeoutMs) {
    card = events.find((e) => e.kind === "approval");
    if (card) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return { events, card, finish: async () => { await done; off(); } };
}

test("parseLinkedinAsk: message and invite forms", () => {
  assert.deepEqual(parseLinkedinAsk("linkedin message https://www.linkedin.com/in/foo: hi there"),
    { kind: "message", url: "https://www.linkedin.com/in/foo", text: "hi there" });
  assert.deepEqual(parseLinkedinAsk("message https://linkedin.com/in/bar on linkedin saying loved your post"),
    { kind: "message", url: "https://linkedin.com/in/bar", text: "loved your post" });
  assert.deepEqual(parseLinkedinAsk("connect with https://linkedin.com/in/baz on linkedin note: fellow IIT Patna here"),
    { kind: "invite", url: "https://linkedin.com/in/baz", text: "fellow IIT Patna here" });
  assert.equal(parseLinkedinAsk("linkedin feed"), null);
  assert.equal(parseLinkedinAsk("message https://linkedin.com/in/bar"), null, "a DM with no text is rejected");
  assert.equal(parseLinkedinAsk("check https://linkedin.com/in/bar"), null);
});

test("risk gate: message request before enabling is refused with instructions, no card", async () => {
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage("linkedin message https://www.linkedin.com/in/foo: hi there").catch(() => {});
  off();
  assert.match(texts(events), /not enabled yet/);
  assert.ok(!events.some((e) => e.kind === "approval"));
});

test("enabled: DM request shows an approval card; Reject sends nothing", async () => {
  setSetting("linkedin_enabled", "1");
  setSetting("linkedin_risk_accepted", "1");
  const { events, card, finish } = await runAndGrabApproval("linkedin message https://www.linkedin.com/in/foo: hi there");
  assert.ok(card, "approval card appears");
  assert.equal(card.action, "linkedin_message");
  assert.deepEqual(card.payload, { url: "https://www.linkedin.com/in/foo", text: "hi there" });
  resolveApproval(card.id, "rejected");
  await finish();
  assert.match(texts(events), /Cancelled - nothing sent/);
});

test("enabled: invite request shows an approval card with the note", async () => {
  const { events, card, finish } = await runAndGrabApproval("connect with https://linkedin.com/in/baz on linkedin note: fellow IIT Patna here");
  assert.ok(card);
  assert.equal(card.action, "linkedin_invite");
  assert.equal((card.payload as any).text, "fellow IIT Patna here");
  resolveApproval(card.id, "rejected");
  await finish();
  assert.match(texts(events), /Cancelled - nothing sent/);
});

test("caps: daily action cap blocks before any browser launches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "li-caps-"));
  const store = new Store(dir);
  store.saveSettings({ linkedin: { enabled: true, riskAccepted: true } } as any);
  const tools = new LinkedInTools(store, dir);
  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  writeFileSync(join(dir, "linkedin-state.json"), JSON.stringify({ date: stamp, feedChecks: 0, actions: 10, lastFeedCheck: 0, lastAction: Date.now() }));
  await assert.rejects(
    () => tools.sendMessage("https://linkedin.com/in/foo", "hi", async () => true),
    (e) => e instanceof LinkedInStopped && /Daily LinkedIn action cap/.test(e.message),
  );
});

test("pacing: actions closer than minActionMinutes are blocked with a wait hint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "li-pace-"));
  const store = new Store(dir);
  store.saveSettings({ linkedin: { enabled: true, riskAccepted: true } } as any);
  const tools = new LinkedInTools(store, dir);
  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  writeFileSync(join(dir, "linkedin-state.json"), JSON.stringify({ date: stamp, feedChecks: 0, actions: 1, lastFeedCheck: 0, lastAction: Date.now() }));
  await assert.rejects(
    () => tools.sendMessage("https://linkedin.com/in/foo", "hi", async () => true),
    (e) => e instanceof LinkedInStopped && /Pacing/.test(e.message),
  );
});

test("gate off at tool level: no enabled flag refuses even with a clean state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "li-gate-"));
  const tools = new LinkedInTools(new Store(dir), dir);
  await assert.rejects(
    () => tools.sendMessage("https://linkedin.com/in/foo", "hi", async () => true),
    (e) => e instanceof LinkedInStopped && /off/.test(e.message),
  );
});
