/** Stage v3.2 e2e: plans and caps through the chat surface with a deterministic fake LLM
 *  (proves the wiring - router -> durable plan -> executor -> denial paths; not real-model NLU). */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-planchat-"));
process.env.AGENT_STATUS_TICK_MS = "50";
process.env.AGENT_CHAT_DEADLINE_MS = "8000";
process.env.MODEL_RACE_BACKOFF_MS = "1";
delete process.env.APP_PASSWORD;

const { handleUserMessage } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");
const { setSetting } = await import("../src2/db.js");
const { getPlan, listPlans } = await import("../src2/plans.js");
const { setCap } = await import("../src2/caps.js");
const { listApplications } = await import("../src2/tracker.js");
const { resolveApproval } = await import("../src2/approvals.js");

function fakeLlm(userMessage: string): string {
  const J = (o: unknown) => JSON.stringify(o);
  const m = userMessage.replace(/^Message: /, "");
  const t = m.toLowerCase();
  if (t.startsWith("plan ")) return J({ commands: [m] }); // a real model maps "plan <goal>" onto the plan command (grammar lists it)
  if (/^track google - step intern and track microsoft - swe intern$/i.test(m))
    return J({ commands: ["track Google - STEP intern", "track Microsoft - SWE intern"] });
  if (/send mail to/.test(t)) return J({ commands: [m.replace(/^please /, "")] });
  if (/^(caps|plans|board\s+\w+|boards|resume plan [a-f0-9]+|cancel plan [a-f0-9]+|unshare \w+)$/.test(t)) return J({ commands: [m] });
  return J({ chat: true });
}

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
        if (sys.includes("intent router")) text = fakeLlm(userMsg);
        else if (sys.includes("draft emails")) text = "Subject: Referral\n\nBody here";
      } catch { /* default */ }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1beta`;
  setSetting("model_provider", "gemini");
  setSetting("model_api_key", "test-key");
  setSetting("model", "gemini-3.8-flash");
  setCap("send_mail", 10);
});
test.after(() => server.close());

async function collect(fn: () => Promise<unknown>) {
  const evs: any[] = [];
  const off = onEvent((e) => evs.push(e));
  try { await fn(); } finally { off(); }
  const texts = evs.filter((e) => e.kind === "text" && e.role === "agent").map((e) => e.text);
  return { evs, texts };
}

test("e2e: 'plan <two tracks>' creates a durable plan, runs both steps, ends done", async () => {
  const { texts } = await collect(() => handleUserMessage("plan track Google - STEP intern and track Microsoft - SWE intern"));
  assert.ok(texts.some((t) => /Plan [a-f0-9]+: /.test(t)), `expected the plan announcement, got: ${texts.join(" | ")}`);
  const plans = listPlans();
  assert.equal(plans.length, 1);
  assert.equal(plans[0].status, "done");
  assert.equal(plans[0].steps.length, 2);
  assert.ok(plans[0].steps.every((s) => s.status === "done"));
  assert.ok(listApplications().some((a) => a.company === "Google"));
  assert.ok(listApplications().some((a) => a.company === "Microsoft"));
});

test("e2e: cap denial - no draft card, nothing sent, clear message", async () => {
  setCap("send_mail", 0);
  const { evs, texts } = await collect(() => handleUserMessage("send mail to mahesh.cs1201@gmail.com asking for referral"));
  assert.ok(texts.some((t) => /Daily send cap reached/.test(t)), `expected the cap message, got: ${texts.join(" | ")}`);
  assert.ok(!evs.some((e) => e.kind === "approval"), "no approval card may be created when the cap denies");
  setCap("send_mail", 10);
});

test("e2e: 'caps' lists today's usage", async () => {
  const { texts } = await collect(() => handleUserMessage("caps"));
  const joined = texts.join("\n");
  assert.match(joined, /send mail: \d+\/\d+/);
  assert.match(joined, /apply: \d+\/\d+/);
});

test("e2e: denial path - a plan step whose send is rejected pauses the plan; resume re-asks", async () => {
  setCap("send_mail", 0);
  const { texts } = await collect(() => handleUserMessage("plan send mail to mahesh.cs1201@gmail.com asking for referral"));
  assert.ok(texts.some((t) => /paused/i.test(t)), `expected a pause message, got: ${texts.join(" | ")}`);
  const p = listPlans()[0];
  assert.equal(p.status, "paused");
  assert.equal(p.steps[0].status, "failed");

  // raise the cap, resume: the draft card must appear; rejecting it pauses the plan again (nothing sends)
  setCap("send_mail", 10);
  const { evs, texts: t2 } = await collect(async () => {
    const run = handleUserMessage(`resume plan ${p.id}`);
    const { db } = await import("../src2/db.js");
    let ap: any = null;
    for (let i = 0; i < 200 && !ap; i++) { // wait for the card to exist (drafting takes a model round-trip)
      ap = db.prepare("SELECT id FROM approvals WHERE status = 'pending' ORDER BY ts DESC LIMIT 1").get();
      if (!ap) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ap, "the resumed plan must issue an approval card");
    resolveApproval(ap.id, "rejected");
    await run;
  });
  assert.ok(evs.some((e) => e.kind === "approval"), "resume must re-issue the approval card");
  assert.ok(t2.some((t) => /Cancelled - nothing sent/.test(t)), `expected the rejection message, got: ${t2.join(" | ")}`);
  assert.equal(getPlan(p.id)!.status, "paused", "rejected send pauses the plan again");
  setCap("send_mail", 10);
});

test("e2e: cancel plan skips remaining steps", async () => {
  setCap("send_mail", 0);
  await collect(() => handleUserMessage("plan send mail to mahesh.cs1201@gmail.com asking for referral"));
  const p = listPlans()[0];
  assert.equal(p.status, "paused");
  const { texts } = await collect(() => handleUserMessage(`cancel plan ${p.id}`));
  assert.ok(texts.some((t) => /cancelled/.test(t)), `expected the cancel message, got: ${texts.join(" | ")}`);
  assert.equal(getPlan(p.id)!.status, "cancelled");
  setCap("send_mail", 10);
});
