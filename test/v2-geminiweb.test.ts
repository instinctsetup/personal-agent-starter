import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
process.env.AGENT_DATA_DIR = `/tmp/agent-v2-gweb-${process.pid}`;
process.env.MODEL_RACE_BACKOFF_MS = "1";
process.env.GEMINI_WEB_PACE_MS = "1";

const { modelRace, buildRacers } = await import("../src2/agent2.js");
const { setSetting } = await import("../src2/db.js");
const { onEvent } = await import("../src2/bus.js");
const { flattenMessages, paceWaitMs, geminiWebEnabled, __setGeminiWebChatForTests } = await import("../src2/geminiweb.js");

function allDownGemini() {
  const srv = http.createServer((_req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "high demand" } }));
  });
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(srv.address() as any).port}/v1beta`, close: () => { srv.close(); (srv as any).closeAllConnections?.(); } }));
  });
}

test("flattenMessages keeps roles readable", () => {
  const flat = flattenMessages([
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "again" },
  ]);
  assert.match(flat, /Instructions: be brief/);
  assert.match(flat, /You said: hello/);
  assert.ok(flat.endsWith("again"));
});

test("paceWaitMs enforces the pacing gap", () => {
  // no call yet -> no wait
  assert.equal(paceWaitMs(10_000_000_000), 0);
});

test("off by default: no web racer even in round 2, enabling adds it last", () => {
  setSetting("model_provider", "gemini");
  setSetting("model_api_key", "k");
  setSetting("model", "gemini-3.8-flash");
  setSetting("gemini_web_enabled", "0");
  assert.equal(geminiWebEnabled(), false);
  assert.ok(!buildRacers([{ role: "user", content: "hi" }], undefined, true).some((r) => r.label.includes("gemini-web")));
  setSetting("gemini_web_enabled", "1");
  const racers = buildRacers([{ role: "user", content: "hi" }], undefined, true);
  assert.equal(racers.at(-1)!.label, "gemini-web (experimental)"); // last = last resort
  // and without includeWeb (round 1) it is absent
  assert.ok(!buildRacers([{ role: "user", content: "hi" }], undefined, false).some((r) => r.label.includes("gemini-web")));
});

test("race: web provider is only called in round 2 and wins when all APIs stay down", async () => {
  const g = await allDownGemini();
  process.env.GEMINI_BASE_URL = g.url;
  setSetting("model_provider", "gemini");
  setSetting("model_api_key", "k");
  setSetting("model", "gemini-3.8-flash");
  setSetting("groq_api_key", "");
  setSetting("openrouter_api_key", "");
  setSetting("gemini_web_enabled", "1");

  let webCalls = 0;
  __setGeminiWebChatForTests(async () => { webCalls++; return "web answer from the site"; });
  const notes: string[] = [];
  const off = onEvent((e) => { if (e.kind === "text" && e.text?.includes("answered first")) notes.push(e.text); });
  try {
    const out = await modelRace("run-web", [{ role: "user", content: "hi" }]);
    assert.equal(out, "web answer from the site");
    assert.equal(webCalls, 1); // exactly one web call, in round 2
    assert.match(notes[0], /gemini-web \(experimental\) answered first/);
  } finally {
    __setGeminiWebChatForTests(null);
    off();
    g.close();
    setSetting("gemini_web_enabled", "0");
  }
});
