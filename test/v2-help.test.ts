/** Help audit: the help output must mention every command family the agent actually handles.
 *  If you add a command to agent2.ts, add it to help AND extend this list - the audit keeps them honest. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-help-"));
process.env.AGENT_STATUS_TICK_MS = "50";

const { handleUserMessage } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");

test("help mentions every command family", async () => {
  const texts: string[] = [];
  const off = onEvent((e) => { if (e.kind === "text" && e.role === "agent") texts.push(e.text); });
  await handleUserMessage("help");
  off();
  const help = texts.join("\n");
  const families = [
    "connect", "gemini-web", "search", "hunt", "open", "sign up", "signups",
    "apply to", "track", "applications", "board", "plan", "caps", "remember",
    "memories", "forget", "local", "skills", "traces", "trace", "send mail",
    "inbox", "drive", "upload", "sync", "git init", "commit", "push",
    "github repo", "every", "jobs", "linkedin", "vault",
  ];
  const missing = families.filter((f) => !help.toLowerCase().includes(f.toLowerCase()));
  assert.deepEqual(missing, [], `help is missing command families: ${missing.join(", ")}`);
});

test("the 'signups' command works (listed in help, previously undocumented)", async () => {
  const texts: string[] = [];
  const off = onEvent((e) => { if (e.kind === "text" && e.role === "agent") texts.push(e.text); });
  await handleUserMessage("signups");
  off();
  assert.match(texts.join("\n"), /No signups yet|via/);
});
