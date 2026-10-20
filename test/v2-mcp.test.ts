/** MCP server: JSON-RPC handshake, tools/list from the registry, schema + cap gates,
 *  approval-gated tools run the real chat flow (card -> resolve -> outcome), tracing, auth. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-mcp-"));
process.env.AGENT_STATUS_TICK_MS = "50";
delete process.env.APP_PASSWORD;

const { buildApp } = await import("../src2/app.js");
const { onEvent } = await import("../src2/bus.js");
const { resolveApproval } = await import("../src2/approvals.js");
const { setCap } = await import("../src2/caps.js");
const { recentRuns } = await import("../src2/trace.js");

const rpc = (app: any, method: string, params?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/mcp", headers: { "content-type": "application/json", ...headers }, payload: { jsonrpc: "2.0", id: 1, method, params } });

test("initialize + ping + notifications + unknown method", async () => {
  const app = await buildApp();
  const init = await rpc(app, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(init.statusCode, 200);
  assert.equal(init.json().result.protocolVersion, "2025-03-26");
  assert.equal(init.json().result.serverInfo.name, "personal-agent");
  assert.ok(init.json().result.capabilities.tools);

  const ping = await rpc(app, "ping");
  assert.deepEqual(ping.json().result, {});

  const note = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", method: "notifications/initialized" } });
  assert.equal(note.statusCode, 202);
  assert.equal(note.body, "");

  const unknown = await rpc(app, "resources/list");
  assert.equal(unknown.json().error.code, -32601);

  const get = await app.inject({ method: "GET", url: "/mcp" });
  assert.equal(get.statusCode, 405);
  await app.close();
});

test("tools/list mirrors the registry with JSON Schema input schemas", async () => {
  const app = await buildApp();
  const { listTools } = await import("../src2/skills.js");
  const res = await rpc(app, "tools/list");
  const tools = res.json().result.tools;
  assert.equal(tools.length, listTools().length);
  const add = tools.find((t: any) => t.name === "tracker.add");
  assert.equal(add.inputSchema.type, "object");
  assert.deepEqual(add.inputSchema.required, ["company"]);
  assert.equal(add.inputSchema.properties.company.type, "string");
  const apply = tools.find((t: any) => t.name === "jobs.apply");
  assert.match(apply.description, /owner-approval/); // risk + gates advertised to clients
  assert.match(apply.description, /daily cap: apply/);
  await app.close();
});

test("tools/call: schema violation and unknown tool are refused before execution", async () => {
  const app = await buildApp();
  const bad = await rpc(app, "tools/call", { name: "tracker.add", arguments: {} });
  assert.equal(bad.json().result.isError, true);
  assert.match(bad.json().result.content[0].text, /missing required argument "company"/);
  const unknown = await rpc(app, "tools/call", { name: "nope.tool", arguments: {} });
  assert.equal(unknown.json().error.code, -32602);
  await app.close();
});

test("tools/call: direct read/write tools execute and are traced as mcp-* runs", async () => {
  const app = await buildApp();
  const add = await rpc(app, "tools/call", { name: "tracker.add", arguments: { company: "MCP Corp", role: "SDE Intern" } });
  assert.equal(add.json().result.isError, false);
  assert.match(add.json().result.content[0].text, /Tracked: MCP Corp - SDE Intern/);
  const list = await rpc(app, "tools/call", { name: "tracker.list", arguments: {} });
  assert.match(list.json().result.content[0].text, /MCP Corp/);
  assert.ok(recentRuns(5).some((r) => r.run_id.startsWith("mcp-") && r.tools.includes("tracker.add")), "an mcp-* run with a tracker.add span exists");
  await app.close();
});

test("tools/call: daily cap denial short-circuits before the flow starts", async () => {
  const app = await buildApp();
  setCap("send_mail", 0);
  const res = await rpc(app, "tools/call", { name: "mail.send", arguments: { to: "x@example.com", body: "hi" } });
  assert.equal(res.json().result.isError, true);
  assert.match(res.json().result.content[0].text, /daily cap for send mail reached/);
  setCap("send_mail", 10);
  await app.close();
});

test("tools/call: approval-gated mail.send surfaces the real card; rejection sends nothing", async () => {
  const app = await buildApp();
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  const pending = rpc(app, "tools/call", { name: "mail.send", arguments: { to: "boss@example.com", body: "quarterly update" } });
  // wait for the approval card, then reject it - the call must complete with nothing sent
  let card: any;
  for (let i = 0; i < 50 && !card; i++) {
    card = events.find((e) => e.kind === "approval" && e.action === "send_email");
    if (!card) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(card, "an approval card appears for the MCP-initiated send");
  resolveApproval(card.id, "rejected");
  const res = await pending;
  off();
  assert.equal(res.json().result.isError, false);
  assert.match(res.json().result.content[0].text, /Cancelled - nothing sent/);
  await app.close();
});

test("auth: APP_PASSWORD gates /mcp via session cookie or bearer token", async () => {
  process.env.APP_PASSWORD = "mcp-test-pw";
  try {
    const app = await buildApp();
    const denied = await rpc(app, "initialize");
    assert.equal(denied.statusCode, 401);
    const bearer = await rpc(app, "initialize", undefined, { authorization: "Bearer mcp-test-pw" });
    assert.equal(bearer.statusCode, 200);
    assert.equal(bearer.json().result.serverInfo.name, "personal-agent");
    const wrong = await rpc(app, "initialize", undefined, { authorization: "Bearer nope" });
    assert.equal(wrong.statusCode, 401);
    await app.close();
  } finally {
    delete process.env.APP_PASSWORD;
  }
});
