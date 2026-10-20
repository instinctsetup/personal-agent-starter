/** Stage 3: persistent browser profile, closed-page recovery, challenge detection, apply-with-resume via chat. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-browser-"));
process.env.AGENT_STATUS_TICK_MS = "50";
process.env.AGENT_CHAT_DEADLINE_MS = "8000";

const br = await import("../src2/browser.js");
const { handleUserMessage } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");
const { resolveApproval } = await import("../src2/approvals.js");
const { ProfileStore } = await import("../src/tools/profile.js");
const { DATA_DIR } = await import("../src2/db.js");

const PAGES: Record<string, string> = {
  "/plain": "<html><body><h1>hello</h1><p>nothing here</p></body></html>",
  "/captcha": '<html><body><div class="g-recaptcha" data-sitekey="x"></div><p>prove you are human</p></body></html>',
  "/twofa": "<html><body><p>Enter the verification code we sent to your phone</p><input></body></html>",
  "/tall": '<html><body style="margin:0"><div style="height:4000px">top</div><div id="bottom">bottom</div></body></html>',
};
let server: Server;
let base: string;

test.before(async () => {
  const jobForm = readFileSync(join(process.cwd(), "test/fixtures/job-form.html"), "utf8");
  server = createServer((req, res) => {
    if (req.url === "/job") { res.writeHead(200, { "content-type": "text/html" }); res.end(jobForm); return; }
    const body = PAGES[req.url || ""] ?? PAGES["/plain"];
    res.writeHead(200, { "content-type": "text/html", "set-cookie": "pa-test=still-here; Path=/" });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

test.after(async () => {
  await br.closeBrowser().catch(() => {});
  server.closeAllConnections(); server.close();
});

test("persistent profile: cookies survive a full browser restart, and a closed page recovers on the same context", async () => {
  const p1 = await br.ensureBrowser();
  await p1.goto(base + "/plain", { waitUntil: "domcontentloaded" });
  await br.closeBrowser(); // full restart, profile dir stays
  const p2 = await br.ensureBrowser();
  await p2.goto(base + "/plain", { waitUntil: "domcontentloaded" });
  const cookies = await p2.context().cookies(base);
  assert.ok(cookies.some((c) => c.name === "pa-test" && c.value === "still-here"), "cookie persisted across restart");
  // user closes the tab -> next ensureBrowser must recover on the SAME context, not relaunch
  const ctx = p2.context();
  await p2.close();
  const p3 = await br.ensureBrowser();
  assert.ok(!p3.isClosed(), "a fresh page is provided");
  assert.equal(p3.context(), ctx, "same persistent context is reused, no profile relaunch");
  await p3.goto(base + "/plain", { waitUntil: "domcontentloaded" });
});

test("detectChallenge flags CAPTCHA and 2FA walls, stays quiet on plain pages", async () => {
  const p = await br.ensureBrowser();
  await p.goto(base + "/captcha", { waitUntil: "domcontentloaded" });
  assert.equal(await br.detectChallenge(), "captcha");
  await p.goto(base + "/twofa", { waitUntil: "domcontentloaded" });
  assert.equal(await br.detectChallenge(), "2fa");
  await p.goto(base + "/plain", { waitUntil: "domcontentloaded" });
  assert.equal(await br.detectChallenge(), null);
});

test("live-view controls: wheel scrolls the page, back/forward walk history", async () => {
  const p = await br.ensureBrowser();
  await p.goto(base + "/plain", { waitUntil: "domcontentloaded" });
  await p.goto(base + "/tall", { waitUntil: "domcontentloaded" });
  await p.mouse.move(640, 400); // the wheel lands where the cursor is, like a real user
  await p.waitForTimeout(100);
  await br.scrollBy(0, 1200);
  await p.waitForTimeout(100);
  const y = await p.evaluate("window.scrollY");
  assert.ok(y > 500, `wheel scrolled the page to y=${y}`);
  assert.match(await br.goBack(), /\/plain$/, "back returns to the previous page");
  assert.match(await br.goForward(), /\/tall$/, "forward re-enters the page");
});

test("take-control flag pauses/resumes cleanly", () => {
  assert.equal(br.isUserControlling(), false);
  br.setUserControl(true);
  assert.equal(br.isUserControlling(), true);
  br.setUserControl(false);
});

test("chat: apply to fixture with a full profile attaches the resume and submits only after approval", async () => {
  const resumePath = join(DATA_DIR, "resume.pdf");
  writeFileSync(resumePath, "%PDF-1.4 fake resume");
  new ProfileStore(DATA_DIR).save({
    firstName: "Mahesh", lastName: "Thakur", email: "mahesh@example.com", phone: "+919999999999",
    linkedin: "https://linkedin.com/in/example", location: "Remote", resumePath,
  } as any);

  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  const done = handleUserMessage(`can u apply to ${base}/job`).catch(() => {});
  // the form's open question is asked in chat; answer it like the user would
  let asked = false;
  for (let i = 0; i < 600 && !asked; i++) {
    asked = events.some((e) => e.kind === "text" && /fact\(s\) I don't have/.test(e.text || ""));
    if (!asked) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(asked, "the applier asks for the unknown required field in chat");
  await handleUserMessage("Because I like distributed systems.").catch(() => {});
  let card: any;
  for (let i = 0; i < 600 && !card; i++) {
    card = events.find((e) => e.kind === "approval" && e.action === "submit_application");
    if (!card) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(card, "submit approval card appears");
  const summary = String(card.summary);
  assert.match(summary, /Mahesh Thakur|Mahesh/, "summary shows the filled name");
  assert.match(summary, /resume/i, "summary shows the resume attach");
  // not submitted yet
  assert.ok(!events.some((e) => e.kind === "text" && /Submitted\./.test(e.text || "")));
  resolveApproval(card.id, "approved");
  await done;
  off();
  const out = events.filter((e) => e.kind === "text" && e.role !== "user").map((e) => e.text).join("\n");
  assert.match(out, /Submitted\. Filled \d+ field\(s\)/, "chat confirms the submission");
  assert.match(out, /Tracked in Jobs & Tracker/, "application is tracked");
});
