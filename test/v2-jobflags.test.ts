/** Tier 2.2: cross-board de-dup + scam/stale flagging in hunt. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-jobflags-"));
process.env.AGENT_STATUS_TICK_MS = "50";

const { handleUserMessage } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");
const { rankResults, scamFlags, canonicalUrl } = await import("../src2/jobflags.js");
const { listApplications } = await import("../src2/tracker.js");

test("canonicalUrl strips tracking params and trailing slashes", () => {
  assert.equal(
    canonicalUrl("https://Boards.example.com/job/123/?utm_source=wa&ref=x"),
    "https://boards.example.com/job/123",
  );
});

test("scamFlags catch the classic patterns", () => {
  assert.ok(scamFlags({ title: "Data entry - earn $500 a day from home", snippet: "no experience needed" }).length >= 1);
  assert.ok(scamFlags({ title: "Hiring", snippet: "Pay a registration fee of 999 to confirm your slot" }).includes("asks for an upfront fee"));
  assert.ok(scamFlags({ title: "Immediate joiner", snippet: "WhatsApp us at 99999 for details" }).length >= 1);
  assert.equal(scamFlags({ title: "SDE Intern - Acme", snippet: "Summer internship, backend team." }).length, 0);
});

test("rankResults collapses cross-board duplicates and sinks scam posts", () => {
  const ranked = rankResults([
    { title: "SDE Intern - Acme", url: "https://a.example/job/1?utm_source=x", snippet: "good" },
    { title: "SDE Intern - Acme", url: "https://b.example/post/9", snippet: "same job, other board" },
    { title: "Easy money", url: "https://c.example/x", snippet: "Earn $500 a day, no experience needed" },
    { title: "Data Intern", url: "https://d.example/y", snippet: "analytics role" },
  ]);
  assert.equal(ranked.length, 4, "duplicates stay visible but marked");
  const clean = ranked.filter((r) => !r.dupOf && !r.flags.length);
  assert.deepEqual(clean.map((r) => r.title), ["SDE Intern - Acme", "Data Intern"]);
  assert.equal(ranked[1].title, "Data Intern");
  assert.ok(ranked.find((r) => r.title === "Easy money")!.flags.length > 0);
  assert.ok(ranked[3].dupOf === 1 || ranked[2].dupOf === 1, "duplicate marked with its first sighting");
});

let server: Server;
test.before(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>ok</body></html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const fixture = `<html><body>
<div class="result results_links"><a class="result__a" href="${base}/job/1">SDE Intern - Acme Corp</a><a class="result__snippet">Backend internship.</a></div>
<div class="result results_links"><a class="result__a" href="${base}/job/1?utm_source=otherboard">SDE Intern - Acme Corp</a><a class="result__snippet">Same posting on another board.</a></div>
<div class="result results_links"><a class="result__a" href="${base}/job/2">Easy Work From Home</a><a class="result__snippet">Earn $500 a day, no experience needed, pay registration fee to start.</a></div>
<div class="result results_links"><a class="result__a" href="${base}/job/3">Data Intern - Gamma</a><a class="result__snippet">Analytics internship.</a></div>
</body></html>`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((u: any, init: any) => {
    const s = String(u);
    if (s.includes("duckduckgo.com") || s.includes("bing.com")) return Promise.resolve(new Response(fixture, { status: 200 }));
    return realFetch(u, init);
  }) as typeof fetch;
});
test.after(async () => { server.closeAllConnections(); server.close(); });

test("hunt collapses the duplicate, warns on the scam post, and tracks only real hits", async () => {
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage("hunt internships").catch(() => {});
  off();
  const out = events.map((e) => e.text || "").join("\n");
  assert.match(out, /Top 3 hits for "internships" \(1 cross-board duplicate\(s\) collapsed\)/);
  assert.match(out, /WARNING: /);
  assert.match(out, /registration fee|fixed earnings/);
  // scam post sinks below the two clean ones
  const iClean1 = out.indexOf("SDE Intern - Acme Corp");
  const iClean2 = out.indexOf("Data Intern - Gamma");
  const iScam = out.indexOf("Easy Work From Home");
  assert.ok(iClean1 < iScam && iClean2 < iScam, "scam posting is last");
  assert.equal(listApplications().filter((a) => a.status === "Scouted").length, 3, "duplicate is not tracked as a separate Scouted entry");
});
