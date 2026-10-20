/** Windows spawn hardening: the "6ms ENOENT clipboard failure" class of bug. */
import test from "node:test";
import assert from "node:assert/strict";
import { powershellCandidatesFor, runPs } from "../src2/winops.js";

test("absolute System32 path is tried first on Windows (PATH-proof)", () => {
  const c = powershellCandidatesFor("win32", "C:\\Windows");
  assert.equal(c[0], "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.ok(c.includes("pwsh"), "PowerShell 7 as last resort");
  assert.deepEqual(powershellCandidatesFor("linux", ""), ["powershell"]);
});

const enoent = (exe: string) => Object.assign(new Error(`spawn ${exe} ENOENT`), { code: "ENOENT" });

test("runPs falls through spawn failures and returns the first shell that launches", async () => {
  const calls: string[] = [];
  const out = await runPs("Get-Clipboard", undefined, 100, async (exe: string) => {
    calls.push(exe);
    if (calls.length < 3) throw enoent(exe);
    return "hello";
  }, ["abs-powershell", "powershell.exe", "powershell"]);
  assert.equal(out, "hello");
  assert.deepEqual(calls, ["abs-powershell", "powershell.exe", "powershell"]);
});

test("a real script failure does NOT retry other shells (errors would multiply)", async () => {
  const calls: string[] = [];
  await assert.rejects(
    runPs("bad-script", undefined, 100, async (exe: string) => { calls.push(exe); throw new Error("Set-Clipboard : The clipboard is busy"); }, ["a", "b", "c"]),
    /clipboard is busy/,
  );
  assert.deepEqual(calls, ["a"], "stopped at the first real error");
});

test("when every candidate fails to spawn, the error names every attempt", async () => {
  await assert.rejects(
    runPs("x", undefined, 100, async (exe: string) => { throw enoent(exe); }, ["one", "two"]),
    (e: Error) => e.message.includes("one: spawn one ENOENT") && e.message.includes("two: spawn two ENOENT"),
  );
});
