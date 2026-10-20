/** Tier 1 winops: system info, clipboard guard rails, allow-listed app launcher. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-winops-"));
process.env.AGENT_STATUS_TICK_MS = "50";

const { handleUserMessage } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");
const { systemInfo, launchApp, isKnownApp, knownApps } = await import("../src2/winops.js");

test("system info reports RAM, CPU and uptime", async () => {
  const info = await systemInfo();
  assert.match(info, /RAM: .* of .* \(\d+%\)/);
  assert.match(info, /CPU: /);
  assert.match(info, /Uptime: \d+h \d+m/);
});

test("'laptop status' command answers with system info", async () => {
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage("laptop status").catch(() => {});
  off();
  const out = events.map((e) => e.text || "").join("\n");
  assert.match(out, /RAM: /);
  assert.ok(events.some((e) => e.kind === "tool_call" && e.tool === "system.info"));
});

test("app launcher refuses programs that are not on the allow-list", async () => {
  assert.ok(isKnownApp("chrome"));
  assert.ok(!isKnownApp("rm"));
  await assert.rejects(() => launchApp("powershell"), /not on the app list/);
  await assert.rejects(() => launchApp("cmd"), /not on the app list/);
  assert.ok(knownApps().includes("Notepad"));
});

test("'open powershell' never launches a shell - it is treated as a browse request or refused", async () => {
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage("launch powershell").catch(() => {});
  off();
  const out = events.map((e) => e.text || "").join("\n");
  assert.match(out, /not on the app list/);
  // the attempt is traced, and the trace records the refusal - not a launch
  const attempt = events.find((e) => e.kind === "tool_call" && e.tool === "app.launch");
  assert.ok(attempt, "the refused attempt is still traceable");
  assert.ok(events.some((e) => e.kind === "error" || /not on the app list/.test(e.text || "")), "refusal is visible in the event stream");
});
