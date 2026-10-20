/** Real-browser channel: the Google "browser may not be secure" fix. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-realbrowser-"));
const br = await import("../src2/browser.js");
const agent = await import("../src2/agent2.js");

test("pickRealBrowser prefers Edge (every Win11 has it), then Chrome, then null", () => {
  assert.equal(br.pickRealBrowser({ edge: true, chrome: true }), "msedge");
  assert.equal(br.pickRealBrowser({ edge: false, chrome: true }), "chrome");
  assert.equal(br.pickRealBrowser({ edge: false, chrome: false }), null);
});

test("installedBrowsers detects standard install paths on win32 only", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-v2-rb-pf-"));
  const edgeDir = join(root, "Microsoft", "Edge", "Application");
  mkdirSync(edgeDir, { recursive: true });
  writeFileSync(join(edgeDir, "msedge.exe"), "");
  const env = { "ProgramFiles(x86)": root, "ProgramFiles": join(root, "nope") };
  assert.deepEqual(br.installedBrowsers("win32", env), { edge: true, chrome: false });
  assert.deepEqual(br.installedBrowsers("linux", env), { edge: false, chrome: false }, "never on linux");
});

test("channel setting + per-channel profile dirs", () => {
  assert.equal(br.browserChannel(), "bundled", "default stays bundled");
  br.setBrowserChannel("msedge");
  assert.equal(br.browserChannel(), "msedge");
  assert.match(br.browserProfileDir("msedge"), /browser-profile-msedge$/, "separate from his personal profile AND the bundled one");
  assert.match(br.browserProfileDir("bundled"), /browser-profile$/);
  br.setBrowserChannel("bundled");
});

test("chat fast-path routes the browser commands", () => {
  assert.equal(agent.matchSystemCommand("use my real browser"), "use my real browser");
  assert.equal(agent.matchSystemCommand("browser status"), "browser status");
  assert.equal(agent.matchSystemCommand("browser bundled"), "browser bundled");
});
