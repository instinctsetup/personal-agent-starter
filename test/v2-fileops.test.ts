/** Tier 1: approval-gated batch rename & downloads cleanup with undo ledger. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-fileops-"));
process.env.AGENT_STATUS_TICK_MS = "50";
process.env.AGENT_APPROVAL_EXPIRY_MS = "30000";

const { handleUserMessage } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");
const { resolveApproval } = await import("../src2/approvals.js");
const { planRename, planDownloadsCleanup, applyMoves, undoLast } = await import("../src2/fileops.js");

function mkDir() { return mkdtempSync(join(tmpdir(), "fileops-fixture-")); }

test("planRename matches files only, applyMoves renames, undoLast reverses", () => {
  const dir = mkDir();
  writeFileSync(join(dir, "resume_acme.pdf"), "a");
  writeFileSync(join(dir, "resume_beta.pdf"), "b");
  writeFileSync(join(dir, "other.txt"), "c");

  const moves = planRename(dir, "resume_", "CV_");
  assert.equal(moves.length, 2);
  applyMoves(moves, "rename");
  assert.ok(existsSync(join(dir, "CV_acme.pdf")));
  assert.ok(existsSync(join(dir, "CV_beta.pdf")));
  assert.ok(existsSync(join(dir, "other.txt")), "non-matching file untouched");

  const r = undoLast("rename");
  assert.equal(r.reversed, 2);
  assert.ok(existsSync(join(dir, "resume_acme.pdf")));
  assert.ok(existsSync(join(dir, "resume_beta.pdf")));
});

test("applyMoves refuses to overwrite an existing file", () => {
  const dir = mkDir();
  writeFileSync(join(dir, "a.txt"), "a");
  writeFileSync(join(dir, "b.txt"), "b");
  assert.throws(() => applyMoves([{ from: join(dir, "a.txt"), to: join(dir, "b.txt") }], "rename"), /Refusing to overwrite/);
  assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "b", "existing file untouched");
});

test("planDownloadsCleanup only archives files older than the cutoff", () => {
  const dir = mkDir();
  const old = join(dir, "old.pdf");
  const fresh = join(dir, "fresh.pdf");
  writeFileSync(old, "x");
  writeFileSync(fresh, "y");
  const past = new Date(Date.now() - 45 * 86_400_000);
  utimesSync(old, past, past);
  const moves = planDownloadsCleanup(dir, 30);
  assert.equal(moves.length, 1);
  assert.match(moves[0].to, /_archive[\\/]\d{4}-\d{2}[\\/]old\.pdf$/);
});

test("rename command: plan -> approval card -> approve applies -> undo command reverses", async () => {
  const dir = mkDir();
  writeFileSync(join(dir, "resume_acme.pdf"), "a");
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  const done = handleUserMessage(`rename files in ${dir} from resume_ to CV_`).catch(() => {});
  // wait for the approval card
  let card: string | undefined;
  for (let i = 0; i < 200 && !card; i++) {
    card = events.find((e) => e.approval_id)?.approval_id;
    if (!card) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(card, "an approval card appears before any rename");
  assert.ok(!existsSync(join(dir, "CV_acme.pdf")), "nothing renamed before approval");
  resolveApproval(card!, "approved");
  await done;
  off();
  assert.ok(existsSync(join(dir, "CV_acme.pdf")), "rename applied after approval");
  assert.match(events.map((e) => e.text || "").join("\n"), /Renamed 1 file/);

  const events2: any[] = [];
  const off2 = onEvent((e) => events2.push(e));
  await handleUserMessage("undo last rename").catch(() => {});
  off2();
  assert.ok(existsSync(join(dir, "resume_acme.pdf")), "undo restored the original name");
  assert.match(events2.map((e) => e.text || "").join("\n"), /Undid 1 rename/);
});

test("rename command: rejecting the card renames nothing", async () => {
  const dir = mkDir();
  writeFileSync(join(dir, "resume_x.pdf"), "a");
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  const done = handleUserMessage(`rename files in ${dir} from resume_ to CV_`).catch(() => {});
  let card: string | undefined;
  for (let i = 0; i < 200 && !card; i++) {
    card = events.find((e) => e.approval_id)?.approval_id;
    if (!card) await new Promise((r) => setTimeout(r, 50));
  }
  resolveApproval(card!, "rejected");
  await done;
  off();
  assert.ok(existsSync(join(dir, "resume_x.pdf")), "rejection leaves files untouched");
  assert.match(events.map((e) => e.text || "").join("\n"), /Cancelled - nothing renamed/);
});
