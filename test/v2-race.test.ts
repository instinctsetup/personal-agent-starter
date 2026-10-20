import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
process.env.AGENT_DATA_DIR = `/tmp/agent-v2-race-${process.pid}`;
process.env.MODEL_RACE_BACKOFF_MS = "1";

const { modelRace, buildRacers } = await import("../src2/agent2.js");
const { setSetting } = await import("../src2/db.js");
const { onEvent } = await import("../src2/bus.js");

type Seen = { model: string; count: number; delays: number[] };
function geminiServer(behavior: Record<string, { status?: number; delayMs?: number; text?: string }>) {
  const seen: Record<string, number> = {};
  const srv = http.createServer(async (req, res) => {
    const m = req.url?.match(/\/models\/([^:]+):generateContent/);
    const model = m ? decodeURIComponent(m[1]) : "unknown";
    seen[model] = (seen[model] || 0) + 1;
    const b = behavior[model] || { status: 200, text: `answer from ${model}` };
    if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
    if (req.destroyed) return;
    if (b.status && b.status !== 200) {
      res.writeHead(b.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "high demand" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: b.text || `answer from ${model}` }] }, finishReason: "STOP" }] }));
  });
  return new Promise<{ url: string; seen: Record<string, number>; close: () => void }>((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(srv.address() as any).port}/v1beta`, seen, close: () => { srv.close(); (srv as any).closeAllConnections?.(); } }));
  });
}

function geminiOk(text: string) {
  return { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] };
}

test("race: fastest healthy model wins, slower calls are cancelled, winner is announced", async () => {
  const g = await geminiServer({
    "gemini-3.8-flash": { status: 200, delayMs: 600, text: "slow primary answer" },
    "gemini-3.5-flash-lite": { status: 200, text: "fast lite answer" },
  });
  process.env.GEMINI_BASE_URL = g.url;
  setSetting("model_provider", "gemini");
  setSetting("model_api_key", "test-key");
  setSetting("model", "gemini-3.8-flash");

  const notes: string[] = [];
  const off = onEvent((e) => { if (e.kind === "text" && e.text?.includes("answered first")) notes.push(e.text); });
  const out = await modelRace("run-test", [{ role: "user", content: "hi" }]);
  off();
  assert.equal(out, "fast lite answer");
  assert.equal(notes.length, 1);
  assert.match(notes[0], /gemini-3\.5-flash-lite answered first/);
  assert.ok(g.seen["gemini-3.8-flash"] >= 1, "primary was also queried");
  g.close();
});

test("race: all-503 round one is retried after backoff and wins in round two", async () => {
  let calls = 0;
  const srv = http.createServer((req, res) => {
    calls++;
    const round2 = calls > 3; // first round fails for all 3 racers hit, second round succeeds
    res.writeHead(round2 ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify(round2 ? geminiOk("round two answer") : { error: { message: "high demand" } }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(srv.address() as any).port}/v1beta`;
  const out = await modelRace("run-test", [{ role: "user", content: "hi" }]);
  assert.equal(out, "round two answer");
  assert.ok(calls > 3, `expected a second round, got ${calls} calls`);
  srv.close(); (srv as any).closeAllConnections?.();
});

test("race: groq key joins the race and wins when gemini is down", async () => {
  const g = await geminiServer({}); // all 200 but slow
  process.env.GEMINI_BASE_URL = g.url;
  const groq = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "groq answer" } }] }));
  });
  await new Promise<void>((r) => groq.listen(0, "127.0.0.1", r));
  process.env.GROQ_BASE_URL = `http://127.0.0.1:${(groq.address() as any).port}`;
  setSetting("groq_api_key", "groq-test-key");

  const g2 = await geminiServer({ "gemini-3.8-flash": { status: 503 }, "gemini-3.5-flash-lite": { status: 503 }, "gemini-3.1-flash-lite": { status: 503 }, "gemini-2.5-flash": { status: 503 } });
  process.env.GEMINI_BASE_URL = g2.url;
  const notes: string[] = [];
  const off = onEvent((e) => { if (e.kind === "text" && e.text?.includes("answered first")) notes.push(e.text); });
  const out = await modelRace("run-test", [{ role: "user", content: "hi" }]);
  off();
  assert.equal(out, "groq answer");
  assert.match(notes[0], /groq\/llama-3\.3-70b answered first/);
  delete process.env.GROQ_BASE_URL;
  g.close(); g2.close(); groq.close(); setSetting("groq_api_key", "");
});

test("buildRacers: single racer skips the race machinery; cap holds", async () => {
  setSetting("model_provider", "openai");
  setSetting("model", "gpt-4o-mini");
  let racers = buildRacers([{ role: "user", content: "hi" }]);
  assert.equal(racers.length, 1);
  setSetting("model_provider", "gemini");
  setSetting("model", "gemini-3.8-flash");
  racers = buildRacers([{ role: "user", content: "hi" }]);
  assert.ok(racers.length <= 4, "fan-out capped");
  assert.ok(racers.some((r) => r.label === "gemini-3.8-flash"));
});
