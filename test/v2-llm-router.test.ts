/** LLM intent router: plain-English -> canonical commands. Model is a deterministic fake
 *  standing in for the real NLU - these tests prove the pipeline (prompt, parse, clarify,
 *  plan, dispatch, fallback), and honestly do NOT prove a real model's phrasing robustness. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-router-"));
process.env.AGENT_STATUS_TICK_MS = "50";
process.env.AGENT_CHAT_DEADLINE_MS = "8000";
process.env.MODEL_RACE_BACKOFF_MS = "1";

const { parseModelRoute, routeWithModel, routerPrompt } = await import("../src2/router.js");
const { handleUserMessage } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");
const { setSetting } = await import("../src2/db.js");
const { resolveApproval } = await import("../src2/approvals.js");

/** A deterministic fake LLM: the rules a decent model would apply, so the pipeline is tested end to end. */
function fakeLlm(userMessage: string): string {
  const t = userMessage.toLowerCase();
  const addr = userMessage.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0];
  const url = userMessage.match(/https?:\/\/\S+|(?:www\.)?[a-z0-9-]+\.(?:com|in|org|dev|io)\S*/i)?.[0];
  const J = (o: unknown) => JSON.stringify(o);
  const huntify = (inner: string) => {
    const q = inner.replace(/^(?:please\s+)?(?:can u|can you|could you)?\s*(?:hunt|find(?: me)?|search(?: for)?)\s*/i, "").replace(/\s*(?:dhundo|dhundho|dhoondo)[?.!]*$/i, "").trim();
    return `hunt ${q || "internships"}`;
  };
  if (/^(hii*|hello|sup|kaise ho|thanks)/.test(t) && t.length < 30) return J({ chat: true });
  // schedule before hunt (a schedule contains a command)
  const ev1 = userMessage.match(/every\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)\s+(.+)/i);
  if (ev1) return J({ commands: [`every ${ev1[1]} ${ev1[2]} ${huntify(ev1[3])}`] });
  const ev2 = userMessage.match(/(.+?)\s+every\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)/i);
  if (ev2) return J({ commands: [`every ${ev2[2]} ${ev2[3]} ${huntify(ev2[1])}`] });
  // inbox before mail-send
  if (/inbox|check.*(mail|email)|any mail|koi mail/.test(t)) return J({ commands: ["inbox"] });
  // mail send: explicit verb, or "mail/email <address>"
  if (/send.*(mail|email)|(mail|email)\s+bhej|mel likh|drop.*(mail|email)|shoot.*mail/.test(t) || /\b(?:mail|email)\s+[A-Za-z0-9._%+-]+@/.test(t)) {
    if (!addr) return J({ clarify: "Which email address should I send it to?" });
    const about = (t.match(/about (.+)|asking (?:for|about) (.+)/) || []);
    return J({ commands: [`send mail to ${addr} asking for ${about[1] || about[2] || "the thing we discussed"}`] });
  }
  if (/hunt|dhundo|dhundho|find.*(job|internship)|search.*(job|internship)/.test(t)) {
    if (/and apply/.test(t)) {
      const q = userMessage.replace(/\s*and apply.*$/i, "");
      return J({ commands: [huntify(q), "apply to 1,2,3"] });
    }
    const tr = userMessage.match(/and (track .+ - .+)$/i);
    if (tr) {
      const q = userMessage.replace(/\s*and track.*$/i, "");
      return J({ commands: [huntify(q), tr[1]] });
    }
    return J({ commands: [huntify(userMessage)] });
  }
  if (/apply/.test(t)) {
    if (/\b\d/.test(t) && !url) return J({ commands: [`apply to ${(t.match(/\d+(?:\s*,\s*\d+)*/) || [""])[0].replace(/\s/g, "")}`] });
    if (!url) return J({ clarify: "Which job posting? Paste the link, or run a hunt first and pick numbers." });
    return J({ commands: [`apply to ${url}`] });
  }
  if (/track/.test(t)) {
    const m = userMessage.match(/track\s+(.+?)\s+-\s+(.+)$/i);
    return m ? J({ commands: [`track ${m[1]} - ${m[2]}`] }) : J({ clarify: "Which company and role? e.g. track Google - STEP intern" });
  }
  if (/open|kholo|browse/.test(t) && url) return J({ commands: [`open ${url}`] });
  if (/linkedin feed/.test(t)) return J({ commands: ["linkedin feed"] });
  if (/connect gemini/.test(t)) return J({ commands: ["connect gemini"] });
  return J({ chat: true });
}
const fakeChat = (msgs: { role: string; content: string }[]) => {
  const m = msgs[1].content.replace(/^Message: /, "");
  return Promise.resolve(fakeLlm(m));
};

const CASES: [string, unknown][] = [
  // mail - 6 phrasings incl. typos + Hinglish
  ["send mail to mahesh.cs1201@gmail.com asking for referal", { kind: "commands", commands: ["send mail to mahesh.cs1201@gmail.com asking for referal"] }],
  ["can u pls mail mahesh.cs1201@gmail.com about the referral", { kind: "commands", commands: ["send mail to mahesh.cs1201@gmail.com asking for the referral"] }],
  ["mahesh.cs1201@gmail.com pe mail bhejo about referral", { kind: "commands", commands: ["send mail to mahesh.cs1201@gmail.com asking for referral"] }],
  ["drop an email to mahesh.cs1201@gmail.com asking about the internship", { kind: "commands", commands: ["send mail to mahesh.cs1201@gmail.com asking for the internship"] }],
  ["shoot a mail to mahesh.cs1201@gmail.com about resume", { kind: "commands", commands: ["send mail to mahesh.cs1201@gmail.com asking for resume"] }],
  ["send him a mail about the internship", { kind: "clarify" }],
  // hunt - 5 phrasings
  ["hunt 2028 batch AI internships", { kind: "commands", commands: ["hunt 2028 batch AI internships"] }],
  ["find me backend internships", { kind: "commands", commands: ["hunt backend internships"] }],
  ["search for remote frontend internships", { kind: "commands", commands: ["hunt remote frontend internships"] }],
  ["AI internships dhundo", { kind: "commands", commands: ["hunt AI internships"] }],
  ["hunt backend internships and apply to the best 3", { kind: "commands", commands: ["hunt backend internships", "apply to 1,2,3"] }],
  // apply - 3
  ["apply to https://unstop.com/jobs/123", { kind: "commands", commands: ["apply to https://unstop.com/jobs/123"] }],
  ["can u apply to this one https://example.com/job/9", { kind: "commands", commands: ["apply to https://example.com/job/9"] }],
  ["apply to this job", { kind: "clarify" }],
  // track - 2
  ["track Google - STEP intern", { kind: "commands", commands: ["track Google - STEP intern"] }],
  ["track that Microsoft application", { kind: "clarify" }],
  // inbox - 2
  ["check my email", { kind: "commands", commands: ["inbox"] }],
  ["koi mail aaya?", { kind: "commands", commands: ["inbox"] }],
  // open - 2
  ["open google.com", { kind: "commands", commands: ["open google.com"] }],
  ["linkedin.com kholo", { kind: "commands", commands: ["open linkedin.com"] }],
  // schedule - 2
  ["every 6 hours hunt AI internships", { kind: "commands", commands: ["every 6 hours hunt AI internships"] }],
  ["can you hunt AI internships every 2 hours", { kind: "commands", commands: ["every 2 hours hunt AI internships"] }],
  // linkedin / connect - 2
  ["show my linkedin feed", { kind: "commands", commands: ["linkedin feed"] }],
  ["connect gemini", { kind: "commands", commands: ["connect gemini"] }],
  // chat - 3
  ["hi", { kind: "chat" }],
  ["what do you think about this resume format", { kind: "chat" }],
  ["thanks!", { kind: "chat" }],
];

test("router: 27 plain-English phrasings map to the right route", async () => {
  let pass = 0;
  const misses: string[] = [];
  for (const [input, want] of CASES) {
    const route = await routeWithModel(input, fakeChat as any);
    const ok = route.kind === (want as any).kind &&
      (route.kind !== "commands" || JSON.stringify(route.commands) === JSON.stringify((want as any).commands));
    if (ok) pass++;
    else misses.push(`${JSON.stringify(input)} -> ${JSON.stringify(route)} (wanted ${JSON.stringify(want)})`);
  }
  console.log(`  [router] ${pass}/${CASES.length} phrasings routed correctly (fake-model pipeline)`);
  if (misses.length) console.log("  misses:\n  " + misses.join("\n  "));
  assert.equal(pass, CASES.length);
});

test("parseModelRoute: fences, surrounding prose, garbage", () => {
  assert.deepEqual(parseModelRoute('```json\n{"commands":["inbox"]}\n```'), { kind: "commands", commands: ["inbox"] });
  assert.deepEqual(parseModelRoute('Sure! Here you go: {"chat": true} hope that helps'), { kind: "chat" });
  assert.equal(parseModelRoute("I have no idea"), null);
  assert.equal(parseModelRoute('{"commands": []}'), null);
  assert.deepEqual(parseModelRoute('{"clarify": "which account?"}'), { kind: "clarify", question: "which account?" });
});

test("router prompt lists the grammar and the raw message", () => {
  const msgs = routerPrompt("kaise ho");
  assert.match(msgs[0].content, /send mail to <address>/);
  assert.match(msgs[0].content, /hunt <search query>/);
  assert.equal(msgs[1].content, "Message: kaise ho");
});

// ---- end-to-end through handleUserMessage with a mock Gemini server ----
let server: Server;
test.before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let text = "ok";
      try {
        const parsed = JSON.parse(body);
        const userMsg: string = parsed.contents?.map((c: any) => c.parts?.map((p: any) => p.text).join(" ")).join(" ") || "";
        const sys: string = parsed.systemInstruction?.parts?.[0]?.text || "";
        if (sys.includes("intent router")) text = fakeLlm(userMsg.replace(/^Message: /, ""));
        else if (sys.includes("draft emails")) text = "Subject: Referral request\n\nHi, asking for a referral. Thanks, Mahesh";
      } catch { /* keep default */ }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1beta`;
  setSetting("model_provider", "gemini");
  setSetting("model_api_key", "test-key");
  setSetting("model", "gemini-3.8-flash");
});
test.after(() => server.close());

test("e2e: vague mail ask gets a clarifying question, then the answer completes the command", async () => {
  const texts: string[] = [];
  const off = onEvent((e) => { if (e.kind === "text" && e.role === "agent") texts.push(e.text); });
  await handleUserMessage("send him a mail about the referral");
  off();
  assert.ok(texts.some((t) => /which email address/i.test(t)), `expected a clarify question, got: ${texts.join(" | ")}`);

  const texts2: string[] = [];
  const off2 = onEvent((e) => {
    if (e.kind === "text" && e.role === "agent") texts2.push(e.text);
    const ap = (e as any).approval_id;
    if (ap) setTimeout(() => resolveApproval(ap, "rejected"), 50); // stop at the card: nothing sends in a test
  });
  await handleUserMessage("mahesh.cs1201@gmail.com");
  off2();
  assert.ok(texts2.some((t) => /Draft ready/.test(t)), `expected the draft card after clarification, got: ${texts2.join(" | ")}`);
});

test("e2e: multi-step request runs as a visible plan", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((u: any, init: any) => {
    const s = String(u);
    if (s.includes("duckduckgo.com") || s.includes("bing.com")) {
      return Promise.resolve(new Response(`<html><body><div class="result results_links"><a class="result__a" href="http://127.0.0.1:1/job">SDE Intern - Acme</a><a class="result__snippet">Backend.</a></div></body></html>`, { status: 200 }));
    }
    return realFetch(u, init);
  }) as typeof fetch;
  const texts: string[] = [];
  const tools: string[] = [];
  const off = onEvent((e) => {
    if (e.kind === "text" && e.role === "agent") texts.push(e.text);
    if (e.kind === "tool_call") tools.push(e.tool || "");
  });
  try {
    await handleUserMessage("hunt backend internships and track Google - STEP intern");
  } finally { globalThis.fetch = realFetch; off(); }
  assert.ok(texts.some((t) => /Plan, 2 steps/.test(t)), `expected a plan message, got: ${texts.join(" | ")}`);
  assert.ok(tools.includes("jobs.hunt"), `expected the hunt step to run, tools: ${tools.join(",")}`);
});
