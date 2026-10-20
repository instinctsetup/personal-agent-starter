/** Tier 3.1: restart recovery - a fresh "process" (re-imported module state is
 *  simulated by calling restore against the durable table) sees the hunt
 *  shortlist and the clarify question; stale rows are swept; fact questions
 *  become a re-ask message. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-convrestore-"));
const cs = await import("../src2/convstate.js");
const agent = await import("../src2/agent2.js");

test("restore brings back hunt + clarify, re-asks facts, sweeps expired", () => {
  const future = Date.now() + 10 * 60_000;
  cs.saveState("web", "hunt", { results: [{ url: "https://jobs.example/1", title: "Dev", snippet: "", flags: [] }], expires: future }, future);
  cs.saveState("web", "clarify", { question: "Which email address?", original: "send a mail" }, future);
  cs.saveState("web", "facts", { questions: ["graduation year"] }, future);
  cs.saveState("web", "hunt", { results: [{ url: "https://jobs.example/1", title: "Dev", snippet: "", flags: [] }], expires: future }, future);
  cs.saveState("old", "clarify", { question: "stale", original: "x" }, Date.now() - 1000);

  const notes: string[] = [];
  const restored = agent.restoreConversationState((t) => notes.push(t));
  assert.equal(restored, 2, "hunt + clarify restored");
  assert.equal(notes.length, 1, "facts became a re-ask message");
  assert.match(notes[0], /graduation year/);
  assert.ok(!cs.loadStates().some((r) => r.channel === "old"), "expired row swept");
  assert.ok(!cs.loadStates().some((r) => r.kind === "facts"), "re-asked facts row cleared");
});
