/** Channel isolation: conversational pending state (hunt shortlists, fact questions,
 *  clarify prompts) is scoped per channel. A message arriving on Telegram/Slack/a
 *  scheduler tick must never be consumed as the answer to a question the web chat asked. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-channels-"));
process.env.AGENT_STATUS_TICK_MS = "50";
process.env.AGENT_CHAT_DEADLINE_MS = "8000";

const { handleUserMessage } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");
const { setCap } = await import("../src2/caps.js");

const ddgFixture = `<html><body>
<div class="result results_links"><a class="result__a" href="http://example.com/job1">SDE Intern - Acme Corp</a><a class="result__snippet">Backend internship.</a></div>
<div class="result results_links"><a class="result__a" href="http://example.com/job2">Frontend Intern - Beta</a><a class="result__snippet">React internship.</a></div>
</body></html>`;

const realFetch = globalThis.fetch;
globalThis.fetch = ((u: any, init: any) => {
  const s = String(u);
  if (s.includes("duckduckgo.com") || s.includes("bing.com")) {
    return Promise.resolve(new Response(ddgFixture, { status: 200 }));
  }
  return realFetch(u, init);
}) as typeof fetch;

test("a hunt shortlist on web is not answerable from another channel", async () => {
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));

  await handleUserMessage("hunt SDE internships", false, "web").catch(() => {});
  assert.match(events.map((e) => e.text || "").join("\n"), /1\. SDE Intern - Acme Corp/, "web gets the shortlist");

  // With the apply cap at 0, any REAL apply attempt is denied instantly (no browser launch),
  // so the two paths are trivially distinguishable:
  //   shortlist consumed -> "Applying to 1 posting(s)" then cap denial
  //   no shortlist       -> plain cap denial only
  setCap("apply", 0);

  // Telegram message must NOT consume the web shortlist.
  await handleUserMessage("apply to 1", false, "telegram:99").catch(() => {});
  const soFar = events.map((e) => e.text || "").join("\n");
  assert.ok(!/Applying to 1 posting/.test(soFar), "telegram did not consume the web shortlist");
  assert.match(soFar, /Daily application cap reached/, "telegram's message routed as its own command");

  // The web shortlist is still open and answerable on web.
  await handleUserMessage("apply to 1", false, "web").catch(() => {});
  const all = events.map((e) => e.text || "").join("\n");
  assert.match(all, /Applying to 1 posting/, "web still had its shortlist and picked from it");

  off();
});
