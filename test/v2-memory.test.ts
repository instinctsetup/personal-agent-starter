/** Stage v3.3: durable memory - store/recall/forget, prompt injection, extraction, secret filtering. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-memory-"));
process.env.AGENT_STATUS_TICK_MS = "50";
process.env.AGENT_CHAT_DEADLINE_MS = "8000";
process.env.MODEL_RACE_BACKOFF_MS = "1";
delete process.env.APP_PASSWORD;

const { addMemory, listMemories, forgetMemory, forgetAll, memoryContext, looksSecret } = await import("../src2/memory.js");
const { routerPrompt } = await import("../src2/router.js");
const { handleUserMessage } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");
const { setSetting } = await import("../src2/db.js");

test("store / list / forget / forget-all round trip", () => {
  const m = addMemory("fact", "Mahesh studies at VIT Bhopal")!;
  assert.ok(m.id);
  addMemory("preference", "Prefers morning interview slots");
  assert.ok(listMemories().some((x) => x.text.includes("VIT Bhopal")));
  assert.equal(forgetMemory(m.id), 1);
  assert.ok(!listMemories().some((x) => x.id === m.id));
  assert.equal(forgetMemory("morning interview"), 1); // fragment delete
  assert.ok(forgetAll() >= 0);
  assert.equal(listMemories().length, 0);
});

test("secret-looking text never becomes a memory", () => {
  assert.equal(addMemory("fact", "my password is hunter2"), null);
  assert.equal(addMemory("fact", "card 4111 1111 1111 1111"), null);
  assert.equal(addMemory("fact", "the OTP 482916"), null);
  assert.equal(addMemory("fact", "api_key sk-abcdefghijklmnop"), null);
  assert.ok(looksSecret("cvv 123"));
  assert.ok(!looksSecret("I prefer remote internships"));
});

test("memoryContext is bounded and ordered: preferences first, newest wins within kind", () => {
  forgetAll();
  addMemory("fact", "old fact");
  addMemory("preference", "likes concise answers");
  addMemory("summary", "Completed plan: x");
  const ctx = memoryContext();
  assert.ok(ctx.indexOf("likes concise answers") < ctx.indexOf("old fact"), "preferences before facts");
  assert.ok(ctx.indexOf("old fact") < ctx.indexOf("Completed plan"), "facts before summaries");
  assert.match(ctx, /What you remember about the user/);
  const tiny = memoryContext(40);
  assert.ok(tiny.length < 200, "bounded");
});

test("router prompt carries the memory block", () => {
  forgetAll();
  addMemory("fact", "targets 2028-batch internships");
  const msgs = routerPrompt("find me internships", memoryContext());
  assert.match(msgs[0].content, /targets 2028-batch internships/);
  assert.equal(msgs[1].content, "Message: find me internships");
});

// ---- chat-surface: extraction + injection across turns ----
let server: Server;
let lastChatHadMemory = false;
test.before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let text = "Got it, noted.";
      try {
        const parsed = JSON.parse(body);
        const sys: string = parsed.systemInstruction?.parts?.[0]?.text || "";
        const contents: any[] = parsed.contents || [];
        const hasSysMem = contents.some((c: any) => c.role !== "user"); // our memory message rides as a system-turn
        if (sys.includes("extract durable user facts")) {
          const u: string = contents.map((c: any) => c.parts?.map((p: any) => p.text).join(" ")).join(" ");
          text = /morning/.test(u) ? '[{"kind":"preference","text":"Prefers morning study sessions"}]' : "[]";
        } else if (sys.includes("intent router")) {
          const u: string = contents.map((c: any) => c.parts?.map((p: any) => p.text).join(" ")).join(" ").replace(/^Message: /, "");
          text = JSON.stringify(/^(remember|memories|memory|forget|what do you remember)/i.test(u) ? { commands: [u] } : { chat: true });
        } else {
          if (sys.includes("What you remember about the user") || hasSysMem) lastChatHadMemory = true;
        }
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
});
test.after(() => server.close());

const texts = (evs: any[]) => evs.filter((e) => e.kind === "text" && e.role === "agent").map((e) => e.text);
async function runChat(msg: string) {
  const evs: any[] = [];
  const off = onEvent((e) => evs.push(e));
  try { await handleUserMessage(msg); } finally { off(); }
  return evs;
}

test("e2e: 'remember' via chat stores; 'memories' lists; 'forget' removes", async () => {
  forgetAll();
  let evs = await runChat("remember that I study at VIT Bhopal");
  assert.ok(texts(evs).some((t) => /I'll remember that/.test(t)), texts(evs).join("|"));
  evs = await runChat("what do you remember");
  assert.ok(texts(evs).some((t) => /VIT Bhopal/.test(t)), texts(evs).join("|"));
  evs = await runChat("forget VIT Bhopal");
  assert.ok(texts(evs).some((t) => /Forgot 1/.test(t)), texts(evs).join("|"));
});

test("e2e: secret via 'remember' is refused, vault pointed", async () => {
  const evs = await runChat("remember my password is hunter2");
  assert.ok(texts(evs).some((t) => /vault/.test(t)), texts(evs).join("|"));
  assert.ok(!listMemories().some((m) => /hunter2/.test(m.text)));
});

test("e2e: chat extraction saves a preference and the NEXT turn carries it", async () => {
  forgetAll();
  lastChatHadMemory = false;
  await runChat("I usually study in the morning before college");
  for (let i = 0; i < 40 && !listMemories().length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(listMemories().some((m) => /morning/i.test(m.text)), `expected an extracted memory, got: ${JSON.stringify(listMemories())}`);
  await runChat("when should I revise today?");
  assert.ok(lastChatHadMemory, "the follow-up chat call must carry the memory block");
});
