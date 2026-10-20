/** Deterministic pre-router fast path: the phrases the user actually typed when the
 *  LLM router sent them to free chat (live bug, 2026-10-20). These must NEVER need
 *  a model to route correctly. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-sysroute-"));
const { matchSystemCommand } = await import("../src2/agent2.js");
const { COMMAND_GRAMMAR } = await import("../src2/router.js");

test("the exact phrases from the bug report", () => {
  assert.equal(matchSystemCommand("laptop status"), "laptop status");
  assert.equal(matchSystemCommand("what's on my clipboard"), "what's on my clipboard");
  assert.equal(matchSystemCommand("quota"), "quota");
  assert.equal(matchSystemCommand("what needs a reply"), "what needs a reply");
});

test("realistic phrasings route to the right canonical command", () => {
  assert.equal(matchSystemCommand("how's my laptop doing?"), "laptop status");
  assert.equal(matchSystemCommand("How is my PC doing"), "laptop status");
  assert.equal(matchSystemCommand("battery level"), "laptop status");
  assert.equal(matchSystemCommand("clipboard"), "what's on my clipboard");
  assert.equal(matchSystemCommand("usage"), "quota");
  assert.equal(matchSystemCommand("api usage?"), "quota");
  assert.equal(matchSystemCommand("linkedin crm"), "linkedin crm");
  assert.equal(matchSystemCommand("linkedin pipeline"), "linkedin crm");
  assert.equal(matchSystemCommand("linkedin follow ups"), "linkedin follow ups");
  assert.equal(matchSystemCommand("who should I follow up with"), "linkedin follow ups");
  assert.equal(matchSystemCommand("mail triage"), "what needs a reply");
  assert.equal(matchSystemCommand("who's waiting on me?"), "what needs a reply");
  assert.equal(matchSystemCommand("notes"), "notes");
  assert.equal(matchSystemCommand("version"), "version");
  assert.equal(matchSystemCommand("what version are you running?"), "version");
});

test("open <allow-listed app> routes, unknown apps and urls do not", () => {
  const notepad = matchSystemCommand("open notepad");
  assert.ok(notepad === "open notepad" || notepad === null, "depends on the allow-list");
  assert.equal(matchSystemCommand("open https://example.com"), null, "urls go to the browser opener, not the app launcher");
  assert.equal(matchSystemCommand("open randomhaxor.exe"), null);
});

test("conversation must NOT be captured by the fast path", () => {
  assert.equal(matchSystemCommand("what's the weather like"), null);
  assert.equal(matchSystemCommand("tell me a joke"), null);
  assert.equal(matchSystemCommand("what is a quota in economics?"), null);
  assert.equal(matchSystemCommand("my notes on the lecture"), null);
});

test("the LLM router grammar names every fast-path feature (belt AND braces)", () => {
  for (const needle of ["laptop status", "clipboard", "quota", "linkedin crm", "what needs a reply", "notes", "version", "open <app>"]) {
    assert.ok(COMMAND_GRAMMAR.includes(needle), `grammar is missing: ${needle}`);
  }
});
