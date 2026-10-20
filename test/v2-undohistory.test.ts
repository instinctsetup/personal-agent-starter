/** Tier 3.4: the undo ledger as a history view + targeted reversal. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-undohist-"));
const work = mkdtempSync(join(tmpdir(), "agent-v2-undohist-files-"));
const fo = await import("../src2/fileops.js");

function seedFile(name: string, content = "x") { const p = join(work, name); writeFileSync(p, content); return p; }

test("ledgerList is newest-first and capped", async () => {
  const a = seedFile("a.txt"); const b = seedFile("b.txt"); const c = seedFile("c.txt");
  fo.applyMoves([{ from: a, to: join(work, "a2.txt") }], "rename");
  await new Promise((r) => setTimeout(r, 5)); // distinct timestamps
  fo.applyMoves([{ from: b, to: join(work, "b2.txt") }, { from: c, to: join(work, "c2.txt") }], "cleanup");
  const list = fo.ledgerList(10);
  assert.equal(list.length, 2);
  assert.equal(list[0].kind, "cleanup", "newest first");
  assert.equal(list[0].moves.length, 2);
  assert.equal(fo.ledgerList(1).length, 1, "cap respected");
});

test("undoEntry reverses only the chosen entry and rewrites the ledger", async () => {
  const list = fo.ledgerList(10);
  const cleanup = list.find((e) => e.kind === "cleanup")!;
  const r = fo.undoEntry(cleanup.ts);
  assert.deepEqual(r, { reversed: 2, skipped: 0 });
  assert.ok(existsSync(join(work, "b.txt")) && existsSync(join(work, "c.txt")), "moved back");
  const after = fo.ledgerList(10);
  assert.equal(after.length, 1, "reversed entry removed");
  assert.equal(after[0].kind, "rename", "the other entry untouched");
  assert.ok(existsSync(join(work, "a2.txt")), "rename NOT reversed");
});

test("undoEntry on a vanished file skips it and keeps it in the ledger", async () => {
  const { unlinkSync } = await import("node:fs");
  unlinkSync(join(work, "a2.txt"));
  const rename = fo.ledgerList(10)[0];
  const r = fo.undoEntry(rename.ts);
  assert.deepEqual(r, { reversed: 0, skipped: 1 });
  assert.equal(fo.ledgerList(10).length, 1, "un-reversable move stays visible");
});

test("undoEntry with an unknown timestamp fails plainly", () => {
  assert.throws(() => fo.undoEntry(12345), /no longer in the ledger/);
});
