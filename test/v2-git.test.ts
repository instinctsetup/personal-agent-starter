import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
process.env.AGENT_DATA_DIR = `/tmp/agent-v2-git-${process.pid}`;
const { initRepo, isRepo, commitAll, statusSummary, parseGithubUrl } = await import("../src2/git.js");

test("parseGithubUrl handles https and .git", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/o/r"), { owner: "o", repo: "r" });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r.git"), { owner: "o", repo: "r" });
  assert.equal(parseGithubUrl("https://example.com/x"), null);
});

test("initRepo creates a repo with an initial commit", async () => {
  const dir = mkdtempSync("/tmp/agent-git-") + "/proj";
  const r = await initRepo(dir, "proj");
  assert.ok(r.created);
  assert.ok(await isRepo(dir));
  assert.match(await statusSummary(dir), /branch main/);
  const again = await initRepo(dir, "proj");
  assert.ok(!again.created);
});

test("commitAll commits changes, null when clean", async () => {
  const dir = mkdtempSync("/tmp/agent-git-") + "/proj2";
  await initRepo(dir, "proj2");
  assert.equal(await commitAll(dir, "nothing"), null);
  writeFileSync(`${dir}/a.txt`, "hello");
  const c = await commitAll(dir, "add a");
  assert.match(c!, /add a/);
  assert.equal(await commitAll(dir, "again"), null);
});
