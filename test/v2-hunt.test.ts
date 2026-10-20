/** Stage 4: job hunt - search -> numbered shortlist -> "apply to N" picks -> tracker. Search is mocked via fetch. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-hunt-"));
process.env.AGENT_STATUS_TICK_MS = "50";
process.env.AGENT_CHAT_DEADLINE_MS = "8000";

const { handleUserMessage } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");
const { listApplications } = await import("../src2/tracker.js");

let server: Server;
let jobUrl: string;
const ddgFixture = (url: string) => `<html><body>
<div class="result results_links"><a class="result__a" href="${url}/job">SDE Intern - Acme Corp</a><a class="result__snippet">Summer 2027 internship, backend.</a></div>
<div class="result results_links"><a class="result__a" href="${url}/job2">Frontend Intern - Beta</a><a class="result__snippet">React internship.</a></div>
<div class="result results_links"><a class="result__a" href="${url}/job3">Data Intern - Gamma</a><a class="result__snippet">Analytics internship.</a></div>
</body></html>`;

test.before(async () => {
  const jobForm = readFileSync(join(process.cwd(), "test/fixtures/job-form.html"), "utf8");
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url?.startsWith("/job") ? jobForm : "<html><body>ok</body></html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  jobUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((u: any, init: any) => {
    const s = String(u);
    if (s.includes("duckduckgo.com")) return Promise.resolve(new Response(ddgFixture(jobUrl), { status: 200 }));
    if (s.includes("bing.com")) return Promise.resolve(new Response(ddgFixture(jobUrl), { status: 200 }));
    return realFetch(u, init);
  }) as typeof fetch;
});

test.after(async () => {
  const br = await import("../src2/browser.js");
  await br.closeBrowser().catch(() => {});
  server.closeAllConnections(); server.close();
});

const texts = (evs: any[]) => evs.filter((e) => e.kind === "text" && e.role !== "user").map((e) => e.text).join("\n");
async function waitFor(events: any[], re: RegExp, ms = 30000) {
  for (let i = 0; i < ms / 50; i++) {
    if (events.some((e) => e.kind === "text" && re.test(e.text || ""))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test("hunt shortlists, tracks as Scouted, and 'apply to 1' drives the real apply flow", async () => {
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage("hunt SDE internships summer 2027").catch(() => {});
  const out = texts(events);
  assert.ok(events.some((e) => e.kind === "tool_call" && e.tool === "jobs.hunt"), "hunt reaches the search tool");
  assert.match(out, /1\. SDE Intern - Acme Corp/);
  assert.match(out, /apply to 1/);
  const scouted = listApplications().filter((a) => a.status === "Scouted");
  assert.equal(scouted.length, 3, "all three hits tracked as Scouted");
  assert.deepEqual(scouted.map((a) => a.url).sort(), [`${jobUrl}/job`, `${jobUrl}/job2`, `${jobUrl}/job3`].sort());

  // pick the first one: the real applier starts and asks its open question
  const done = handleUserMessage("apply to 1").catch(() => {});
  assert.ok(await waitFor(events, /fact\(s\) I don't have/), "the applier asks the form's open question");
  await handleUserMessage("skip").catch(() => {});
  await done;
  off();
  const out2 = texts(events);
  assert.match(out2, /Not submitted \(needs-facts\)/, "skipped facts -> nothing submitted");
});

test("a duplicate hunt does not double-track known URLs", async () => {
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage("hunt SDE internships summer 2027").catch(() => {});
  off();
  assert.equal(listApplications().filter((a) => a.status === "Scouted").length, 3, "still three - deduped by URL");
  assert.match(texts(events), /already tracked/);
});

test("invalid picks are rejected; unrelated messages do not trigger applies", async () => {
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage("apply to 9").catch(() => {});
  off();
  assert.match(texts(events), /None of those numbers/);
  assert.ok(!events.some((e) => e.kind === "tool_call" && e.tool === "jobs.apply"));

  const events2: any[] = [];
  const off2 = onEvent((e) => events2.push(e));
  await handleUserMessage("hunt SDE internships summer 2027").catch(() => {});
  await handleUserMessage("check my email").catch(() => {});
  off2();
  assert.ok(events2.some((e) => e.kind === "tool_call" && e.tool === "mail.inbox"), "normal routing still works with an open shortlist");
  assert.ok(!events2.some((e) => e.kind === "tool_call" && e.tool === "jobs.apply"), "no apply triggered");
});

test("'find me ... internships' natural form also hunts", async () => {
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage("find me backend internships").catch(() => {});
  off();
  assert.ok(events.some((e) => e.kind === "tool_call" && e.tool === "jobs.hunt"));
});
