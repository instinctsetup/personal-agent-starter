/** Tier 2.4: mail triage - "what needs a reply". */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), "agent-v2-triage-"));
process.env.AGENT_STATUS_TICK_MS = "50";

const { handleUserMessage } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");
const { triageMail, setInboxFetcherForTests } = await import("../src2/mail.js");
type MailSummary = import("../src2/mail.js").MailSummary;

const now = Date.now();
const mail = (uid: number, from: string, subject: string, snippet: string, ageH = 5): MailSummary =>
  ({ uid, from, subject, snippet, date: new Date(now - ageH * 3_600_000).toISOString() });

test("triageMail excludes automated mail and ranks by signal strength", () => {
  const inbox = [
    mail(1, "GitHub <notifications@github.com>", "Your build passed", "ci passed"),
    mail(2, "Priya <priya@example.com>", "Following up on my referral mail", "Did you get a chance to send it?"),
    mail(3, "Recruiter <jobs@acme.com>", "Your application - next steps", "We'd like to schedule your interview. Please confirm a slot."),
    mail(4, "News <newsletter@site.com>", "Weekly digest", "top stories"),
    mail(5, "Mom <mom@example.com>", "call when free", "no pressure"),
  ];
  const top = triageMail(inbox, now);
  const subjects = top.map((t) => t.subject);
  assert.ok(!subjects.includes("Your build passed"), "notifications excluded");
  assert.ok(!subjects.includes("Weekly digest"), "newsletters excluded");
  assert.ok(subjects.indexOf("Your application - next steps") < 2, "job mail near the top");
  assert.ok(top.find((t) => t.uid === 3)!.reasons.join(" ").match(/job-search related/));
  assert.ok(top.find((t) => t.uid === 2)!.reasons.join(" ").match(/following up/));
});

test("'what needs a reply' answers with the triaged list", async () => {
  const { setSetting } = await import("../src2/db.js");
  setSetting("email_user", "him@example.com");
  setSetting("email_pass", "fake-app-password"); // mailConfigured() needs user + pass (same as v2-mailquery)
  setInboxFetcherForTests(async () => [
    mail(1, "Recruiter <jobs@acme.com>", "Interview slot confirmation needed", "Please confirm your slot by tomorrow."),
    mail(2, "Spam <newsletter@x.com>", "Flash sale", "50% off"),
  ]);
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage("what needs a reply").catch(() => {});
  off();
  const out = events.map((e) => e.text || "").join("\n");
  assert.match(out, /Interview slot confirmation needed/);
  assert.match(out, /why: /);
  assert.ok(!/Flash sale/.test(out), "newsletter excluded");
  setInboxFetcherForTests(null);
});

test("triage with a clean inbox says so", async () => {
  setInboxFetcherForTests(async () => [mail(1, "GitHub <notifications@github.com>", "Your build passed", "ok")]);
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage("what needs a reply").catch(() => {});
  off();
  assert.match(events.map((e) => e.text || "").join("\n"), /caught up/);
  setInboxFetcherForTests(null);
});
