/** Tier 2.6: LinkedIn mini-CRM store. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-licrm-"));
const crm = await import("../src2/licrm.js");

const URL_A = "https://www.linkedin.com/in/priya-sharma-123/";
const URL_B = "https://www.linkedin.com/in/recruiter-rahul";

test("recordOutreach stores slug, note, and a 3-day follow-up", () => {
  const row = crm.recordOutreach("message", URL_A, "Hi Priya, loved your post about hiring...", 3);
  assert.equal(row.slug, "priya-sharma-123");
  assert.equal(row.status, "sent");
  assert.ok(row.follow_up_due! > Date.now() + 2.9 * 86400000, "due ~3 days out");
  assert.match(row.note!, /loved your post/);
});

test("slugOf handles trailing slash, query params, and non-profile urls", () => {
  assert.equal(crm.slugOf("https://www.linkedin.com/in/jane-doe/?trk=abc"), "jane-doe");
  assert.equal(crm.slugOf("not-a-url"), "not-a-url");
});

test("dueFollowUps only returns overdue, still-open conversations", async () => {
  crm.recordOutreach("invite", URL_B, "connect note", 3);
  assert.equal(crm.dueFollowUps().length, 0, "nothing due yet");
  const old = crm.recordOutreach("message", "https://www.linkedin.com/in/old-contact", "hey", 3);
  // backdate the due time into the past
  const { db } = await import("../src2/db.js");
  db.prepare("UPDATE linkedin_outreach SET follow_up_due = ? WHERE id = ?").run(Date.now() - 1000, old.id);
  const due = crm.dueFollowUps();
  assert.deepEqual(due.map((r) => r.slug), ["old-contact"]);
});

test("markReplied clears the follow-up; markFollowedUp closes the loop", () => {
  const replied = crm.markReplied("priya-sharma-123");
  assert.equal(replied?.status, "replied");
  assert.equal(replied?.follow_up_due, null);
  assert.equal(crm.markReplied("ghost-person"), null);
  const fu = crm.markFollowedUp("old-contact");
  assert.equal(fu?.status, "followed_up");
  assert.equal(crm.dueFollowUps().length, 0, "nothing left due");
});

test("listOutreach newest-first and formatOutreach readable", () => {
  const rows = crm.listOutreach();
  assert.ok(rows.length >= 3);
  assert.ok(rows[0].id > rows[rows.length - 1].id);
  const text = crm.formatOutreach(rows);
  assert.match(text, /priya-sharma-123/);
  assert.match(text, /replied/);
});
