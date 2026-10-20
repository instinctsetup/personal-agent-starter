/** Tier 1: local OCR command plumbing (recognition seam injected - no language download). */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-ocr-"));
process.env.AGENT_STATUS_TICK_MS = "50";

const { handleUserMessage } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");
const { setRecognizeForTests, ocrImage } = await import("../src2/ocr.js");

test.after(() => setRecognizeForTests(null));

test("read the text in <image> OCRs the file locally", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-fixture-"));
  const img = join(dir, "shot.png");
  writeFileSync(img, Buffer.from("fake-png-bytes"));
  setRecognizeForTests(async (p) => {
    assert.equal(p, img, "the OCR receives the exact image path");
    return "Error: cannot connect to server";
  });
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage(`read the text in ${img}`).catch(() => {});
  off();
  const out = events.map((e) => e.text || "").join("\n");
  assert.match(out, /Error: cannot connect to server/);
  assert.ok(events.some((e) => e.kind === "tool_call" && e.tool === "image.ocr"));
});

test("ocr of a missing file is a clean error, not a crash", async () => {
  await assert.rejects(() => ocrImage("C:\\nope\\missing.png"), /does not exist/);
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage("read the text in C:\\nope\\missing.png").catch(() => {});
  off();
  assert.match(events.map((e) => e.text || "").join("\n"), /does not exist/);
});

test("screen OCR outside Windows explains itself", async () => {
  if (process.platform === "win32") { assert.ok(true); return; } // real capture path, exercised on his laptop
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage("what does my screen say").catch(() => {});
  off();
  assert.match(events.map((e) => e.text || "").join("\n"), /Windows only/);
});
