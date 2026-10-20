/** Regression: the 2026-10-20 transcript where a pasted Google-Form quiz URL got
 *  circular "which form?" questions instead of the form flow. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-formroute-"));
const agent = await import("../src2/agent2.js");

const URL = "https://docs.google.com/forms/d/e/1FAIpQLSdYlxIwrctHcxvs1Kwnc8FqHxQoe1CzZa26Q4aENzCFZ8-n0w/viewform";
const CH = "web";

test("a pasted forms URL IS the command - no 'which form?' question", () => {
  assert.equal(agent.matchFormFlowCommand(URL, CH), `fill form ${URL}`);
  assert.equal(agent.matchFormFlowCommand(`answer all and submit ${URL}`, CH), `fill form ${URL}`);
  assert.equal(agent.matchFormFlowCommand(`${URL}.`, CH), `fill form ${URL}`, "trailing punctuation stripped");
});

test("the exact transcript: short follow-ups resolve against the pasted URL", () => {
  agent.rememberTurn(CH, "user", URL);                       // he pastes the link
  agent.rememberTurn(CH, "agent", "What's the form for?");   // old bad behavior, still in history
  agent.rememberTurn(CH, "user", "its a quiz");
  assert.equal(agent.matchFormFlowCommand("answer all the question", CH), `fill form ${URL}`);
  assert.equal(agent.matchFormFlowCommand("it is in the form", CH), `fill form ${URL}`);
  agent.rememberTurn(CH, "user", URL);                       // he pastes it again
  assert.equal(agent.matchFormFlowCommand("answer all and submit", CH), `fill form ${URL}`);
});

test("no form URL in channel history -> no form command (no hallucinated target)", () => {
  assert.equal(agent.matchFormFlowCommand("submit", "fresh-channel"), null);
  assert.equal(agent.matchFormFlowCommand("answer all", "fresh-channel"), null);
});

test("conversation is not captured", () => {
  assert.equal(agent.matchFormFlowCommand("what is a google form?", CH), null);
  assert.equal(agent.matchFormFlowCommand("how do forms work", CH), null);
});

test("channel isolation: a form URL on web does not leak into telegram", () => {
  assert.equal(agent.matchFormFlowCommand("answer all", "telegram"), null);
});
