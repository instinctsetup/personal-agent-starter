/** Tier 2.1: ATS-aware form extraction - Workday/Greenhouse/Lever DOM conventions. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-ats-"));
process.env.AGENT_STATUS_TICK_MS = "50";
process.env.AGENT_CHAT_DEADLINE_MS = "8000";

const br = await import("../src2/browser.js");
const forms = await import("../src2/forms.js");

const WORKDAY_HTML = `<html><body>
<div data-automation-id="formField-firstName">
  <label data-automation-id="formField-firstName-label">First Name</label>
  <input type="text" data-automation-id="formField-firstName-input" />
</div>
<div data-automation-id="formField-email">
  <label data-automation-id="formField-email-label">Email Address</label>
  <input type="text" data-automation-id="formField-email-input" />
</div>
<button data-automation-id="pageFooterNextButton">Save and Continue</button>
</body></html>`;

const GREENHOUSE_HTML = `<html><body>
<div class="field"><label for="job_application_first_name">First name *</label>
<input type="text" id="job_application_first_name" name="job_application[first_name]" /></div>
<div class="field"><label for="job_application_email">Email *</label>
<input type="text" id="job_application_email" name="job_application[email]" /></div>
<div class="field"><input type="text" name="job_application[location]" placeholder="City" /></div>
<input type="submit" value="Submit application" />
</body></html>`;

const PROFILE = { firstName: "Mahesh", lastName: "Thakur", email: "mahesh@example.com", location: "Patna" };

let server: Server;
let base: string;
test.before(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url === "/workday" ? WORKDAY_HTML : req.url === "/greenhouse" ? GREENHOUSE_HTML : "<html><body>ok</body></html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.after(async () => { await br.closeBrowser().catch(() => {}); server.closeAllConnections(); server.close(); });

test("Workday: labels come from data-automation-id containers, 'Save and Continue' reads as next", async () => {
  const page = await br.ensureBrowser();
  await page.goto(base + "/workday");
  const { questions, hasNext } = await page.evaluate(forms.extractForTests) as any;
  assert.ok(Array.isArray(questions), "extraction returned questions");
  assert.deepEqual(questions.map((q: any) => q.label), ["First Name", "Email Address"]);
  assert.ok(hasNext, "Workday's 'Save and Continue' recognized as a next button");
});

test("Greenhouse: label[for] works, placeholder-only field falls back cleanly, 'Submit application' is the submit", async () => {
  const page = await br.ensureBrowser();
  await page.goto(base + "/greenhouse");
  const { questions, hasSubmit } = await page.evaluate(forms.extractForTests) as any;
  assert.deepEqual(questions.map((q: any) => q.label), ["First name", "Email", "City"]);
  assert.ok(hasSubmit, "'Submit application' recognized as submit");
});
