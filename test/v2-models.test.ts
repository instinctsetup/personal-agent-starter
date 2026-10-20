/** Live model resolution: connect-time model picking from the provider's own /models list,
 *  docs-verified fallback chain, tiny-completion verification. Reproduces the Groq 404 bug:
 *  a retired model (llama-3.3-70b-versatile) must never be the end of the line. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-models-"));
process.env.AGENT_STATUS_TICK_MS = "50";

const { resolveModel, currentModel, PROVIDERS, listLiveModels } = await import("../src2/models.js");
const { getSetting } = await import("../src2/db.js");
const { handleSetupSubmit } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");

type MockOpts = { models: string[] | null; good: string[]; gemini?: boolean };
/** A mock provider: /models (or 500 when null), chat completions 404 for ids not in `good`. */
async function mockProvider(opts: MockOpts): Promise<string> {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://x");
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (opts.gemini) {
      if (url.pathname === "/models") {
        if (opts.models === null) return json(500, {});
        return json(200, { models: opts.models.map((id) => ({ name: `models/${id}`, supportedGenerationMethods: ["generateContent"] })) });
      }
      const m = url.pathname.match(/^\/models\/([^:]+)(:generateContent)?$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (m[2]) return opts.good.includes(id) ? json(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] }) : json(404, { error: { message: "not found" } });
        return opts.good.includes(id) || (opts.models || []).includes(id) ? json(200, { name: `models/${id}` }) : json(404, { error: { message: "not found" } });
      }
      return json(404, {});
    }
    if (url.pathname === "/models") {
      if (opts.models === null) return json(500, { error: "listing down" });
      return json(200, { data: opts.models.map((id) => ({ id })) });
    }
    if (url.pathname === "/chat/completions") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const model = JSON.parse(body || "{}").model;
        if (opts.good.includes(model)) return json(200, { choices: [{ message: { content: "ok" } }] });
        json(404, { error: { message: `The model \`${model}\` does not exist or you do not have access to it (model_not_found)` } });
      });
      return;
    }
    json(404, {});
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port;
  (srv as any).unref?.();
  return `http://127.0.0.1:${port}`;
}

test("Mahesh's bug: retired llama-3.3-70b-versatile absent from live list -> best live alternative is picked", async () => {
  process.env.GROQ_BASE_URL = await mockProvider({ models: ["openai/gpt-oss-120b", "llama-3.1-8b-instant"], good: ["openai/gpt-oss-120b", "llama-3.1-8b-instant"] });
  const r = await resolveModel("groq", "test-key");
  assert.equal(r.model, "openai/gpt-oss-120b");
  assert.equal(r.source, "live");
  assert.equal(getSetting("groq_model"), "openai/gpt-oss-120b");
  assert.deepEqual(r.tried, ["openai/gpt-oss-120b"]); // the dead default was never attempted
  delete process.env.GROQ_BASE_URL;
});

test("listing endpoint down -> docs-verified fallback chain, verified by tiny completions", async () => {
  process.env.CEREBRAS_BASE_URL = await mockProvider({ models: null, good: ["qwen-3.8-27b"] });
  const r = await resolveModel("cerebras", "test-key");
  assert.equal(r.model, "qwen-3.8-27b");            // first two preferences 404, third answers
  assert.equal(r.source, "fallback");
  assert.deepEqual(r.tried, ["llama-3.3-70b", "gpt-oss-120b", "qwen-3.8-27b"]);
  delete process.env.CEREBRAS_BASE_URL;
});

test("openrouter: live picks are restricted to :free ids even when paid models top the list", async () => {
  process.env.OPENROUTER_BASE_URL = await mockProvider({
    models: ["openai/gpt-5.2", "google/gemma-4-31b-it:free"],
    good: ["openai/gpt-5.2", "google/gemma-4-31b-it:free"],
  });
  const live = await listLiveModels(PROVIDERS.openrouter, "k");
  const r = await resolveModel("openrouter", "k");
  assert.ok(live && live.includes("openai/gpt-5.2")); // listing works...
  assert.equal(r.model, "google/gemma-4-31b-it:free"); // ...but paid ids are never picked
  delete process.env.OPENROUTER_BASE_URL;
});

test("every candidate dead -> honest error naming what was tried", async () => {
  process.env.GROQ_BASE_URL = await mockProvider({ models: ["something/else"], good: [] });
  await assert.rejects(() => resolveModel("groq", "k"), /none of the candidate models answered \(tried: llama-3\.3-70b-versatile/);
  delete process.env.GROQ_BASE_URL;
});

test("currentModel: resolved setting wins, bare default is only the pre-connect fallback", async () => {
  assert.equal(currentModel("groq"), "openai/gpt-oss-120b"); // saved by the first test
  assert.equal(currentModel("github-models"), PROVIDERS["github-models"].preferences[0]);
});

test("e2e connect: 'connect groq' resolves, saves and reports the picked model", async () => {
  process.env.GROQ_BASE_URL = await mockProvider({ models: ["llama-3.1-8b-instant"], good: ["llama-3.1-8b-instant"] });
  const texts: string[] = [];
  const off = onEvent((e) => { if (e.kind === "text" && e.role === "agent") texts.push(String(e.text ?? "")); });
  const status = await handleSetupSubmit("groq", { groq_api_key: "gsk_test" });
  off();
  assert.equal(status, "ok");
  assert.equal(getSetting("groq_model"), "llama-3.1-8b-instant");
  assert.match(texts.join("\n"), /Groq connected - using llama-3\.1-8b-instant \(picked from your account's live model list\)/);
  delete process.env.GROQ_BASE_URL;
});

test("gemini: live resolution through the v1beta model list and generateContent ping", async () => {
  process.env.GEMINI_BASE_URL = await mockProvider({ gemini: true, models: ["gemini-2.5-flash", "gemini-3.8-flash"], good: ["gemini-3.8-flash", "gemini-2.5-flash"] });
  const r = await resolveModel("gemini", "AIza-test");
  assert.equal(r.model, "gemini-3.8-flash"); // first preference, present live, ping OK
  assert.equal(getSetting("model"), "gemini-3.8-flash");
  delete process.env.GEMINI_BASE_URL;
});
