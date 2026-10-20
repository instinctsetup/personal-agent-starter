/** Tier 3.3: autostart builders (the schtasks calls themselves are Windows-only;
 *  here we verify the argument lists, the launcher script, and exec plumbing). */
import test from "node:test";
import assert from "node:assert/strict";
import { createArgs, deleteArgs, queryArgs, launcherScript, installAutostart, removeAutostart, TASK_NAME } from "../scripts/autostart.mjs";

test("create args: per-user logon task, limited rights, no shell string", () => {
  const a = createArgs("C:\\dev\\personal-agent-starter\\scripts\\start-agent.cmd");
  assert.deepEqual(a.slice(0, 3), ["/Create", "/TN", TASK_NAME]);
  assert.ok(a.includes("ONLOGON"));
  assert.ok(a.includes("LIMITED"), "per-user task, no admin");
  assert.ok(a.includes("/F"), "overwrite an older install");
  assert.equal(a[a.indexOf("/TR") + 1], '"C:\\dev\\personal-agent-starter\\scripts\\start-agent.cmd"');
});

test("delete and query arg shapes", () => {
  assert.deepEqual(deleteArgs(), ["/Delete", "/TN", TASK_NAME, "/F"]);
  assert.deepEqual(queryArgs(), ["/Query", "/TN", TASK_NAME]);
});

test("launcher script cds to repo root and logs console output", () => {
  const s = launcherScript();
  assert.match(s, /cd \/d "%~dp0\.\."/);
  assert.match(s, /npm start >> data\\agent-console\.log/);
});

test("install/remove report schtasks failures plainly (non-Windows here)", () => {
  const r = installAutostart("/tmp/x");
  assert.equal(r.ok, process.platform === "win32");
  if (process.platform !== "win32") assert.match(r.detail, /Windows-only/);
  const d = removeAutostart();
  if (process.platform !== "win32") assert.match(d.detail, /Windows-only/);
});
