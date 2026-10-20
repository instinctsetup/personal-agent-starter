/** Mail questions route to mail tools, never to capability-denying free chat.
 *  Reproduces Mahesh's failure: "what does the 2step mail say" with a model that
 *  (a) routes everything to chat and (b) denies inbox access. Both behaviors must lose. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-mailq-"));
process.env.AGENT_STATUS_TICK_MS = "50";
process.env.AGENT_CHAT_DEADLINE_MS = "8000";
process.env.MODEL_RACE_BACKOFF_MS = "1";

const { handleUserMessage } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");
const { setSetting } = await import("../src2/db.js");
const { filterMail, setInboxFetcherForTests } = await import("../src2/mail.js");

const BAD_CHAT_REPLY = "I don't have access to your email inbox. Please paste the text of the mail here.";
const FAKE_MAILS = [
  { uid: 3, from: "Google <no-reply@accounts.google.com>", subject: "2-Step Verification turned on", date: "2026-10-19T10:00:00Z", snippet: "Your 2-Step Verification is on. Your verification code is 481516. If this wasn't you, secure your account." },
  { uid: 2, from: "Priya Sharma <priya@example.com>", subject: "Re: internship referral", date: "2026-10-18T09:00:00Z", snippet: "Happy to refer you - send over your resume and the job id." },
  { uid: 1, from: "Unstop <updates@unstop.com>", subject: "New hackathon alert", date: "2026-10-17T08:00:00Z", snippet: "A new hackathon matches your profile." },
];

let server: Server;
let routerCalls = 0;
let lastChatSys = "";
test.before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let text = BAD_CHAT_REPLY;
      try {
        const parsed = JSON.parse(body);
        const sys: string = parsed.systemInstruction?.parts?.[0]?.text || "";
        if (sys.includes("intent router")) { routerCalls++; text = JSON.stringify({ chat: true }); } // the bad router: everything is "chat"
        else lastChatSys = sys;
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
test.after(() => { server.close(); setInboxFetcherForTests(null); });

const chat = async (text: string) => {
  const texts: string[] = [];
  const off = onEvent((e) => { if (e.kind === "text" && e.role === "agent") texts.push(String(e.text ?? "")); });
  await handleUserMessage(text);
  off();
  return texts.join("\n");
};

test("Mahesh's exact phrase, email NOT connected: connect guidance, zero model calls, no denial", async () => {
  routerCalls = 0;
  const out = await chat("what does the 2step mail say");
  assert.match(out, /Email isn't connected yet/);
  assert.match(out, /connect email/);
  assert.match(out, /app password/i);
  assert.doesNotMatch(out, /don't have access/i);
  assert.equal(routerCalls, 0, "deterministic routing - the bad router model is never even asked");
});

test("connected: the real mail content is returned (2step squashed-match), no denial", async () => {
  setSetting("email_user", "mahesh@example.com");
  setSetting("email_pass", "fake-app-password"); // mailConfigured() needs user + pass
  setSetting("imap_host", "imap.example.com");
  setSetting("smtp_host", "smtp.example.com");
  setInboxFetcherForTests(async () => FAKE_MAILS);
  const out = await chat("what does the 2step mail say");
  assert.match(out, /Found it:/);
  assert.match(out, /2-Step Verification turned on/);
  assert.match(out, /481516/); // the actual body content via mail.read
  assert.doesNotMatch(out, /don't have access/i);
});

test("'any reply from priya' finds only her mail", async () => {
  const out = await chat("any reply from priya");
  assert.match(out, /Priya Sharma/);
  assert.match(out, /internship referral/);
  assert.doesNotMatch(out, /Unstop/);
});

test("no match says so honestly", async () => {
  const out = await chat("what does the zyxwvb mail say");
  assert.match(out, /Nothing in your recent mail matches "zyxwvb"/);
});

test("canonical routed command 'mail search google' works through the cascade", async () => {
  const out = await chat("mail search google");
  assert.match(out, /accounts\.google\.com/);
});

test("free chat is grounded with real capabilities + connection state", async () => {
  lastChatSys = "";
  const out = await chat("how are you doing today");
  assert.match(out, /don't have access/); // free chat still reaches the model (race note may prefix it)...
  assert.match(lastChatSys, /Email: CONNECTED/); // ...but grounded: mail is connected in this file
  assert.match(lastChatSys, /NEVER claim you cannot access/);
  assert.match(lastChatSys, /mail search <words>/);
});

test("filterMail: squashed alnum matching + stopwords + all-words-required", () => {
  assert.equal(filterMail(FAKE_MAILS, "2step").length, 1);
  assert.equal(filterMail(FAKE_MAILS, "verification code").length, 1);
  assert.equal(filterMail(FAKE_MAILS, "priya referral").length, 1);
  assert.equal(filterMail(FAKE_MAILS, "priya hackathon").length, 0); // words span different mails
  assert.equal(filterMail(FAKE_MAILS, "").length, 3); // empty query = all
});
