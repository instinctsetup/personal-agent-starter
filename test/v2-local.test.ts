/** Stage v3.4: local SLMs via Ollama - detection, honest VRAM tiering, chat, pull, race + router integration, fallback. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-local-"));
process.env.AGENT_STATUS_TICK_MS = "50";
process.env.AGENT_CHAT_DEADLINE_MS = "8000";
process.env.MODEL_RACE_BACKOFF_MS = "1";
process.env.OLLAMA_FAKE_VRAM_MB = "4096";
delete process.env.APP_PASSWORD;

const { pickModels, ollamaChat, localStatus, setLocalEnabled, pulledModels } = await import("../src2/local.js");
const { handleUserMessage, modelRace } = await import("../src2/agent2.js");
const { newRunId: newRunIdForTest } = await import("../src2/bus.js");
const { onEvent } = await import("../src2/bus.js");
const { setSetting } = await import("../src2/db.js");

test("VRAM tiering: honest picks per card class", () => {
  assert.equal(pickModels(4096)!.chat, "qwen3.5:2b");   // RTX 2050 class
  assert.equal(pickModels(4096)!.router, "gemma3:1b");
  assert.equal(pickModels(6144)!.chat, "qwen3.5:4b");
  assert.equal(pickModels(8192)!.chat, "llama3.1:8b");
  assert.equal(pickModels(16384)!.chat, "qwen3:8b");
  assert.equal(pickModels(2048)!.chat, "llama3.2:1b");
  assert.equal(pickModels(1024), null);                  // below 2GB: don't pretend
});

// ---- mock Ollama server ----
let ollama: Server;
let ollamaBase: string;
let chatCalls: string[] = [];
let chatBehavior: (model: string) => string | Error = () => "local answer";
test.before(async () => {
  ollama = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/api/version") { res.end(JSON.stringify({ version: "0.12.0" })); return; }
      if (req.url === "/api/tags") { res.end(JSON.stringify({ models: [{ name: "qwen3.5:2b" }, { name: "gemma3:1b" }] })); return; }
      if (req.url === "/v1/chat/completions") {
        const model = JSON.parse(body || "{}").model || "?";
        chatCalls.push(model);
        const out = chatBehavior(model);
        if (out instanceof Error) { res.writeHead(500); res.end(out.message); return; }
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: out } }] }));
        return;
      }
      if (req.url === "/api/pull") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.end(JSON.stringify({ status: "pulling", total: 100, completed: 50 }) + "\n" + JSON.stringify({ status: "success", total: 100, completed: 100 }) + "\n");
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise<void>((r) => ollama.listen(0, "127.0.0.1", r));
  ollamaBase = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`;
  process.env.OLLAMA_BASE_URL = ollamaBase;
});
test.after(() => ollama.close());

test("detection: status against a live Ollama shows tier + both models pulled", async () => {
  const st = await localStatus();
  assert.equal(st.ollama, true);
  assert.equal(st.vramMb, 4096);
  assert.equal(st.tier!.chat, "qwen3.5:2b");
  assert.deepEqual(st.missing, []);
  assert.deepEqual(st.ready.sort(), ["gemma3:1b", "qwen3.5:2b"]);
  assert.deepEqual((await pulledModels()).sort(), ["gemma3:1b", "qwen3.5:2b"]);
});

test("ollamaChat: returns content, throws on HTTP error and on empty reply", async () => {
  chatBehavior = () => "hello from local";
  assert.equal(await ollamaChat("qwen3.5:2b", [{ role: "user", content: "hi" }]), "hello from local");
  chatBehavior = () => new Error("model not found");
  await assert.rejects(() => ollamaChat("nope:0b", []), /Ollama 500/);
  chatBehavior = () => "";
  await assert.rejects(() => ollamaChat("qwen3.5:2b", []), /empty/);
  chatBehavior = () => "local answer";
});

test("race integration: local model joins and can win; when everything is down the race honestly fails", async () => {
  // cloud racer pointed at a dead port so the LOCAL model is the only viable one
  setSetting("model_provider", "gemini");
  setSetting("model_api_key", "test-key");
  setSetting("model", "gemini-3.8-flash");
  process.env.GEMINI_BASE_URL = "http://127.0.0.1:1/v1beta";
  setSetting("local_chat_model", "qwen3.5:2b");
  setLocalEnabled(true);
  chatCalls = [];
  chatBehavior = () => "local wins";
  const r1 = await modelRace(newRunIdForTest(), [{ role: "user", content: "hi" }], undefined, true);
  assert.equal(r1, "local wins");
  assert.ok(chatCalls.includes("qwen3.5:2b"));
  // local down too -> the race must fail honestly, not fabricate an answer
  chatBehavior = () => new Error("connection refused");
  await assert.rejects(() => modelRace(newRunIdForTest(), [{ role: "user", content: "hi" }], undefined, true));
  setLocalEnabled(false);
});

test("router prefers the local 1B model; falls back to the race when it fails", async () => {
  setLocalEnabled(true);
  setSetting("local_router_model", "gemma3:1b");
  setSetting("local_chat_model", "qwen3.5:2b");
  chatCalls = [];
  chatBehavior = (m) => (m === "gemma3:1b" ? JSON.stringify({ commands: ["inbox"] }) : "local chat");
  const evs: any[] = [];
  const off = onEvent((e) => evs.push(e));
  await handleUserMessage("check my email");
  off();
  assert.ok(chatCalls.includes("gemma3:1b"), `router model used, calls: ${chatCalls}`);
  assert.ok(evs.some((e) => e.kind === "text" && /isn't connected/i.test(e.text || "")), "inbox command ran");
  // router model down -> the race takes routing (cloud is dead in this env, so the local chat model answers it)
  chatBehavior = (m) => (m === "gemma3:1b" ? new Error("down") : JSON.stringify({ commands: ["inbox"] }));
  chatCalls = [];
  const evs2: any[] = [];
  const off2 = onEvent((e) => evs2.push(e));
  await handleUserMessage("check my email");
  off2();
  assert.ok(evs2.some((e) => e.kind === "text" && /isn't connected/i.test(e.text || "")), "routing survived local-router failure");
  setLocalEnabled(false);
});

test("chat: 'local status' reports the honest state; 'local off' disables", async () => {
  const run = async (msg: string) => {
    const evs: any[] = [];
    const off = onEvent((e) => evs.push(e));
    try { await handleUserMessage(msg); } finally { off(); }
    return evs.filter((e) => e.kind === "text" && e.role === "agent").map((e) => e.text).join("\n");
  };
  const out = await run("local status");
  assert.match(out, /4GB card/);
  assert.match(out, /qwen3\.5:2b \(pulled\)/);
  const offOut = await run("local off");
  assert.match(offOut, /off/i);
});
