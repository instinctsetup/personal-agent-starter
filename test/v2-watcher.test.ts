/** Tier 1: folder watcher pings chat on new files, ext filter + persistence. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-watcher-"));
process.env.AGENT_STATUS_TICK_MS = "50";

const { handleUserMessage } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");
const { startWatch, stopWatch, listWatchers, stopAllWatchers } = await import("../src2/watcher.js");

test.after(() => stopAllWatchers());

test("watch command announces a new matching file and ignores others", async () => {
  const dir = mkdtempSync(join(tmpdir(), "watch-fixture-"));
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage(`watch ${dir} for new pdf`).catch(() => {});
  assert.match(events.map((e) => e.text || "").join("\n"), new RegExp(`Watching ${dir.replace(/[\\/]/g, ".")}`));
  assert.equal(listWatchers().length, 1);

  writeFileSync(join(dir, "offer-letter.pdf"), "x");
  writeFileSync(join(dir, "ignore-me.txt"), "y");
  let announced = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (events.some((e) => /New file in .*offer-letter\.pdf/.test(e.text || ""))) { announced = true; break; }
  }
  off();
  assert.ok(announced, "the new PDF was announced");
  assert.ok(!events.some((e) => /ignore-me\.txt/.test(e.text || "")), "non-matching file ignored");
});

test("watch specs persist to watchers.json; unwatch removes them", async () => {
  stopAllWatchers(); // clear test 1's watch
  const dir = mkdtempSync(join(tmpdir(), "watch-fixture-"));
  const spec = startWatch(dir, null);
  const store = JSON.parse(readFileSync(join(process.env.AGENT_DATA_DIR!, "watchers.json"), "utf8"));
  assert.equal(store.length, 1);
  assert.equal(store[0].dir, dir);

  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage("watching").catch(() => {});
  await handleUserMessage(`unwatch ${spec.id}`).catch(() => {});
  off();
  assert.match(events.map((e) => e.text || "").join("\n"), /Stopped watching/);
  assert.equal(listWatchers().length, 0);
  assert.ok(!existsSync(join(process.env.AGENT_DATA_DIR!, "watchers.json")) || JSON.parse(readFileSync(join(process.env.AGENT_DATA_DIR!, "watchers.json"), "utf8")).length === 0);
});

test("watching a missing folder is refused", async () => {
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage("watch C:\\definitely\\not\\here").catch(() => {});
  off();
  assert.match(events.map((e) => e.text || "").join("\n"), /does not exist/);
});
