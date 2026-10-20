/** Graded-assessment guard: a points-scored form is shown, never filled, until he says "anyway". */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-quiz-"));
process.env.AGENT_STATUS_TICK_MS = "50";
process.env.AGENT_CHAT_DEADLINE_MS = "8000";

const br = await import("../src2/browser.js");
const forms = await import("../src2/forms.js");

const QUIZ_HTML = `<html><head><title>Chapter 4 Quiz</title></head><body>
<div>Total points: 2</div>
<div class="field"><label for="q1">What is 2+2?</label><span>1 point</span><input type="text" id="q1" name="q1" /></div>
<div class="field"><label for="q2">Capital of France?</label><span>1 point</span><input type="text" id="q2" name="q2" /></div>
<input type="submit" value="Submit" />
</body></html>`;

let server: Server; let base: string;
test.before(async () => {
  server = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(QUIZ_HTML); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/quiz`;
});
test.after(async () => { await br.closeBrowser().catch(() => {}); server.closeAllConnections(); server.close(); });

const hooks = { say: () => {}, askFacts: async () => ({}), confirm: async () => false };

test("quiz-shaped form stops with quiz_check, listing the questions + the rule", async () => {
  const r = await forms.runFormFill({ url: base, profile: { firstName: "Mahesh" } }, hooks);
  assert.equal(r.status, "quiz_check");
  assert.match(r.error!, /graded quiz or exam/i);
  assert.match(r.error!, /What is 2\+2/);
  assert.match(r.error!, /fill form .* anyway/);
});

test("allowQuiz ('fill form <url> anyway') bypasses the guard and runs the normal flow", async () => {
  const r = await forms.runFormFill({ url: base, profile: { firstName: "Mahesh" }, allowQuiz: true }, hooks);
  assert.notEqual(r.status, "quiz_check", "guard bypassed with anyway");
});
