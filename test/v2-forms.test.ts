/** "fill form <url>": mock Google-Forms multi-page fixture, real Chromium, review gate, fail-visible chat. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-forms-"));
process.env.AGENT_STATUS_TICK_MS = "50";
process.env.AGENT_CHAT_DEADLINE_MS = "8000";

const br = await import("../src2/browser.js");
const forms = await import("../src2/forms.js");
const { handleUserMessage } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");
const { resolveApproval } = await import("../src2/approvals.js");
const { ProfileStore } = await import("../src/tools/profile.js");
const { DATA_DIR } = await import("../src2/db.js");

let server: Server;
let base: string;

test.before(async () => {
  const gform = readFileSync(join(process.cwd(), "test/fixtures/gform-mock.html"), "utf8");
  server = createServer((req, res) => {
    if (req.url === "/gform") { res.writeHead(200, { "content-type": "text/html" }); res.end(gform); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><h1>hello</h1><p>nothing here</p></body></html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

test.after(async () => {
  await br.closeBrowser().catch(() => {});
  server.closeAllConnections(); server.close();
});

const PROFILE = {
  firstName: "Mahesh", lastName: "Thakur", email: "mahesh@example.com", phone: "+919999999999",
  education: "B.Tech in Computer Science", university: "IIT Patna",
};

test("answerFromFacts maps real question labels to profile facts and never invents", () => {
  assert.equal(forms.answerFromFacts("Full name", "text", PROFILE), "Mahesh Thakur");
  assert.equal(forms.answerFromFacts("Email", "text", PROFILE), "mahesh@example.com");
  assert.equal(forms.answerFromFacts("Phone number", "text", PROFILE), "+919999999999");
  assert.equal(forms.answerFromFacts("Highest education", "dropdown", PROFILE), "B.Tech in Computer Science");
  assert.equal(forms.answerFromFacts("Upload your resume", "file", { ...PROFILE, resumePath: "/x/resume.pdf" }), "/x/resume.pdf");
  assert.equal(forms.answerFromFacts("Which role are you applying for?", "radio", PROFILE), "");
  assert.equal(forms.answerFromFacts("Why do you want to join?", "paragraph", PROFILE), "");
});

test("matchOption: exact, prefix, includes, and honest -1", () => {
  const opts = ["Software Engineer", "Data Analyst", "Product Manager"];
  assert.equal(forms.matchOption(opts, "Software Engineer"), 0);
  assert.equal(forms.matchOption(opts, "software engineer"), 0);
  assert.equal(forms.matchOption(opts, "data"), 1);
  assert.equal(forms.matchOption(["B.Tech", "M.Tech", "MBA"], "B.Tech in Computer Science"), 0);
  assert.equal(forms.matchOption(opts, "Astronaut"), -1);
  assert.equal(forms.matchOption(opts, ""), -1);
});

function mkHooks(answers: Record<string, string>, approve: boolean, seen: { asked?: string[]; summary?: string }) {
  return {
    say: () => {},
    askFacts: async (qs: string[]) => { seen.asked = (seen.asked || []).concat(qs); return answers; },
    confirm: async (summary: string) => { seen.summary = summary; return approve; },
  };
}

test("runFormFill: multi-page mock Google Form fills from profile + asked facts, gates on review, submits with screenshot proof", async () => {
  const resumePath = join(DATA_DIR, "resume.pdf");
  writeFileSync(resumePath, "%PDF-1.4 fake resume");
  const seen: { asked?: string[]; summary?: string } = {};
  const res = await forms.runFormFill({ url: base + "/gform", profile: { ...PROFILE, resumePath }, resumePath }, mkHooks({
    "Which role are you applying for?": "Software Engineer",
    "Which skills do you have?": "Python, Excel",
    "Why do you want to join?": "I love building things.",
  }, true, seen));
  assert.equal(res.status, "submitted", res.error || "");
  assert.equal(res.pages, 2, "both pages were walked");
  // asked exactly for the unknowns - never for facts the profile already has
  assert.deepEqual(seen.asked, ["Which role are you applying for?", "Which skills do you have?", "Why do you want to join?"]);
  // review card carried every answer before submit
  assert.match(seen.summary || "", /Review before I submit/);
  assert.match(seen.summary || "", /Full name: Mahesh Thakur/);
  assert.match(seen.summary || "", /Email: mahesh@example\.com/);
  // confidence tags: user-supplied answers are marked, profile facts are not
  assert.match(seen.summary || "", /Why do you want to join\?: I love building things\. \[your answer\]/);
  assert.ok(!/Full name: Mahesh Thakur \[/.test(seen.summary || ""), "solid profile facts carry no warning tag");
  assert.match(seen.summary || "", /Highest education: B\.Tech in Computer Science/);
  assert.match(seen.summary || "", /resume\.pdf/);
  assert.equal(res.answered["Full name"], "Mahesh Thakur");
  assert.equal(res.answered["Which role are you applying for?"], "Software Engineer");
  assert.equal(res.answered["Which skills do you have?"], "Python, Excel");
  assert.equal(res.answered["Why do you want to join?"], "I love building things.");
  assert.equal(res.answered["Upload your resume"], "resume.pdf");
  assert.equal(res.unknowns.length, 0, JSON.stringify(res.unknowns));
  assert.ok(res.screenshot && res.screenshot.length > 1000, "confirmation screenshot captured");
});

test("runFormFill: reject on the review card cancels - nothing is submitted", async () => {
  const res = await forms.runFormFill({ url: base + "/gform", profile: { ...PROFILE } }, mkHooks({
    "Which role are you applying for?": "Data Analyst",
    "Which skills do you have?": "Java",
    "Why do you want to join?": "Because.",
  }, false, {}));
  assert.equal(res.status, "cancelled");
});

test("runFormFill: an answer matching no option is reported honestly, never guessed", async () => {
  const seen: { summary?: string } = {};
  const res = await forms.runFormFill({ url: base + "/gform", profile: { ...PROFILE } }, mkHooks({
    "Which role are you applying for?": "Astronaut",
    "Which skills do you have?": "Python",
    "Why do you want to join?": "x",
  }, true, seen));
  assert.equal(res.status, "submitted");
  assert.ok(res.unknowns.some((u) => /couldn't set "Astronaut"/.test(u)), JSON.stringify(res.unknowns));
  assert.match(seen.summary || "", /Left empty\/unanswered:.*Astronaut/s);
});

test("runFormFill: a non-form page fails with a clear reason", async () => {
  const res = await forms.runFormFill({ url: base + "/plain", profile: PROFILE }, mkHooks({}, true, {}));
  assert.equal(res.status, "failed");
  assert.match(res.error || "", /No questions found/);
});

test("chat: 'fill form <url>' end to end - asks in chat, review card, approve, submitted + confirmation shot", async () => {
  const resumePath = join(DATA_DIR, "resume.pdf");
  writeFileSync(resumePath, "%PDF-1.4 fake resume");
  new ProfileStore(DATA_DIR).save({ ...PROFILE, resumePath } as any);

  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  const done = handleUserMessage(`fill form ${base}/gform`).catch(() => {});
  let asked = false;
  for (let i = 0; i < 600 && !asked; i++) {
    asked = events.some((e) => e.kind === "text" && /answer\(s\) I don't have/.test(e.text || ""));
    if (!asked) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(asked, "unknowns are asked in chat");
  await handleUserMessage("Software Engineer").catch(() => {});
  // page 2 asks its own unknowns - answer them too
  let asks = 0;
  for (let i = 0; i < 600 && asks < 2; i++) {
    asks = events.filter((e) => e.kind === "text" && /answer\(s\) I don't have/.test(e.text || "")).length;
    if (asks < 2) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(asks >= 2, "page 2 asks its own unknowns");
  await handleUserMessage("Python, Excel\nI love building things.").catch(() => {});
  let card: any;
  for (let i = 0; i < 600 && !card; i++) {
    card = events.find((e) => e.kind === "approval" && e.action === "form_submit");
    if (!card) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(card, "review/approval card appears before submit");
  assert.match(String(card.summary), /Full name: Mahesh Thakur/);
  resolveApproval(card.id, "approved");
  await done;
  off();
  const out = events.filter((e) => e.kind === "text" && e.role !== "user").map((e) => e.text).join("\n");
  assert.match(out, /Submitted - the confirmation is on screen/, "chat reports the submission honestly");
  assert.match(out, /Answered \d+ question\(s\) across 2 page\(s\)/);
  const shot = events.find((e) => e.kind === "text" && e.screenshot);
  assert.ok(shot && existsSync(shot.screenshot), "confirmation screenshot delivered in chat");
});

test("chat: 'fill form' on a non-form page says exactly what failed and why", async () => {
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage(`fill form ${base}/plain`).catch(() => {});
  off();
  const out = events.filter((e) => e.kind === "text" && e.role !== "user").map((e) => e.text).join("\n");
  assert.match(out, /Couldn't finish \(failed\)\. No questions found on this page/, "failure is visible with the reason");
});

test("answerFromFactsTagged: profile facts are solid, memory guesses are tagged", async () => {
  const { addMemory } = await import("../src2/memory.js");
  const direct = forms.answerFromFactsTagged("Full name", "short", { firstName: "Mahesh", lastName: "Thakur" });
  assert.equal(direct.source, "profile");
  addMemory("fact", "Graduation year is 2027", "user");
  const guessed = forms.answerFromFactsTagged("Graduation year?", "short", {});
  assert.equal(guessed.source, "memory");
  assert.match(guessed.ans, /2027/);
  const none = forms.answerFromFactsTagged("Favorite color", "short", {});
  assert.equal(none.source, "");
  assert.equal(none.ans, "");
});
