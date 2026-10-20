/** Regression tests for the Claude second-pass review fixes. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-secondpass-"));
const br = await import("../src2/browser.js");
const fo = await import("../src2/fileops.js");
const m = await import("../src2/matchers.js");
const caps = await import("../src2/caps.js");

test("installedBrowsers finds per-user (no-admin) Chrome/Edge under %LocalAppData%", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-v2-sp-local-"));
  const chromeDir = join(root, "Google", "Chrome", "Application");
  mkdirSync(chromeDir, { recursive: true });
  writeFileSync(join(chromeDir, "chrome.exe"), "");
  const env = { "ProgramFiles(x86)": join(root, "nope86"), "ProgramFiles": join(root, "nope"), "LocalAppData": root };
  assert.deepEqual(br.installedBrowsers("win32", env), { edge: false, chrome: true }, "per-user Chrome must be found");
});

test("case-only rename works (NTFS quirk) and undo restores it", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-v2-sp-case-"));
  const lower = join(dir, "resume.pdf");
  writeFileSync(lower, "x");
  const moves = [{ from: lower, to: join(dir, "RESUME.pdf") }];
  fo.applyMoves(moves, "rename");
  assert.ok(existsSync(join(dir, "RESUME.pdf")), "case-only rename applied via temp two-step");
  fo.undoLast("rename");
  assert.ok(existsSync(lower), "undo restored the original casing");
});

test("planRename refuses system folders even when the path does not exist here", () => {
  assert.throws(() => fo.planRename("C:\\Windows\\System32", "a", "b"), /system folder/);
  assert.throws(() => fo.planRename("C:\\", "a", "b"), /system folder/);
});

test("rename has a default daily cap like every other destructive fs op", () => {
  assert.equal(caps.capOf("rename"), 20);
});

test("rememberTurn ignores disposable scheduler channels (no unbounded growth)", () => {
  m.rememberTurn("scheduler:job-1:123", "agent", "hello");
  assert.equal(m.recentTurns.has("scheduler:job-1:123"), false);
  m.rememberTurn("web", "user", "hi");
  assert.ok(m.recentTurns.get("web")!.length >= 1);
});

test("runChannel map stays bounded via rememberRunChannel", () => {
  for (let i = 0; i < 2100; i++) m.rememberRunChannel(`run-${i}`, "web");
  assert.ok(m.runChannel.size <= 2000, `bounded at 2000, got ${m.runChannel.size}`);
  assert.equal(m.runChannel.get("run-2099"), "web", "newest kept");
  assert.equal(m.runChannel.get("run-0"), undefined, "oldest evicted");
});

test("watcher dedups the same folder typed differently (normalized compare)", async () => {
  const w = await import("../src2/watcher.js");
  const dir = mkdtempSync(join(tmpdir(), "agent-v2-sp-watch-"));
  const a = w.startWatch(dir, ".pdf");
  const b = w.startWatch(join(dir, "."), ".pdf"); // same folder, different spelling
  assert.equal(a.id, b.id, "same folder is one watcher");
  assert.ok(w.stopWatch(dir + "/") || w.stopWatch(dir), "stoppable by path spelling");
});
