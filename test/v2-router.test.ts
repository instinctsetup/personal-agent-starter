/** Plain-English router: chat-filler prefixes reach the same commands, and send intents still win. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = `/tmp/agent-v2-router-${process.pid}`;
process.env.AGENT_STATUS_TICK_MS = "50";
process.env.AGENT_CHAT_DEADLINE_MS = "4000";

const { handleUserMessage, normalizeCommand } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");

test.after(async () => {
  const br = await import("../src2/browser.js");
  await br.closeBrowser().catch(() => {});
});

async function runChat(text: string) {
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage(text).catch(() => {});
  off();
  return events;
}
const texts = (evs: any[]) => evs.filter((e) => e.kind === "text" && e.role !== "user").map((e) => e.text).join("\n");
const tools = (evs: any[]) => evs.filter((e) => e.kind === "tool_call").map((e) => e.tool);

test("normalizeCommand strips filler openers, keeps the command", () => {
  assert.equal(normalizeCommand("can u apply to https://x.io/job"), "apply to https://x.io/job");
  assert.equal(normalizeCommand("can you please track Google - STEP intern"), "track Google - STEP intern");
  assert.equal(normalizeCommand("hey check my email"), "check my email");
  assert.equal(normalizeCommand("pls sign me up on unstop with google"), "sign me up on unstop with google");
  assert.equal(normalizeCommand("apply to https://x.io/job"), "apply to https://x.io/job");
  assert.equal(normalizeCommand("ok so now just track Acme"), "track Acme");
});

test("'can u track Google - STEP intern' adds to the tracker", async () => {
  const evs = await runChat("can u track Google - STEP intern");
  assert.ok(tools(evs).includes("tracker.add"));
  assert.match(texts(evs), /Tracked: Google - STEP intern/);
});

test("'can u apply to <url>' runs the applier end-to-end against a fixture form", async () => {
  const html = readFileSync(join(process.cwd(), "test/fixtures/job-form.html"), "utf8");
  const server: Server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/job`;
  try {
    const evs = await runChat(`can u apply to ${url}`);
    assert.ok(tools(evs).includes("jobs.apply"), "apply intent reaches jobs.apply");
    // empty profile -> the applier asks for facts instead of inventing them; nothing submitted
    assert.match(texts(evs), /Not submitted \(needs-facts\)/);
    assert.ok(!evs.some((e) => e.kind === "approval"), "no submit approval requested when facts are missing");
  } finally { server.closeAllConnections(); server.close(); }
});

test("'please search for ...' reaches web.search", async () => {
  const evs = await runChat("please search for definitely-not-a-real-thing-xyzzy-12345");
  assert.ok(tools(evs).includes("web.search"));
});

test("'sign me up on <site> with google' reaches the signup engine", async () => {
  const evs = await runChat("sign me up on http://127.0.0.1:1/x with google");
  assert.ok(tools(evs).includes("signup.google"));
});

test("'can u check my email' still reads the inbox, never sends", async () => {
  const evs = await runChat("can u check my email");
  assert.ok(tools(evs).includes("mail.inbox"));
  assert.ok(!evs.some((e) => e.kind === "approval"));
});

test("exact command forms still work after normalization", async () => {
  const evs = await runChat("track Flipkart - SDE intern");
  assert.match(texts(evs), /Tracked: Flipkart - SDE intern/);
  const evs2 = await runChat("help");
  assert.match(texts(evs2), /plain English works/);
});
