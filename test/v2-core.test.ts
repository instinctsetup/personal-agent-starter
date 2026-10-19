/** v2 core: vault crypto, OTP extraction, search parsing, tracker, approvals. */
import test from "node:test";
import assert from "node:assert/strict";

process.env.AGENT_DATA_DIR = `/tmp/agent-v2-test-${process.pid}`;

const { encryptSecret, decryptSecret, generatePassword, saveCredential, getCredential, listCredentials } = await import("../src2/vault.js");
const { extractOtp, extractVerificationLink } = await import("../src2/otp.js");
const { parseDuckDuckGoHtml } = await import("../src2/search.js");
const { addApplication, listApplications, updateApplication, deleteApplication, trackerCsv } = await import("../src2/tracker.js");
const { requestApproval, resolveApproval, waitApproval, getApproval } = await import("../src2/approvals.js");
const { db } = await import("../src2/db.js");

test("vault: encrypt/decrypt round-trip + tamper detection", () => {
  const enc = encryptSecret("my-secret-p@ss");
  assert.notEqual(enc, "my-secret-p@ss");
  assert.equal(decryptSecret(enc), "my-secret-p@ss");
  const [iv, tag, body] = enc.split(".");
  assert.throws(() => decryptSecret(`${iv}.${tag}.${body.slice(0, -2)}aa`));
});

test("vault: generated passwords are strong and unique", () => {
  const a = generatePassword(), b = generatePassword();
  assert.notEqual(a, b);
  assert.equal(a.length, 20);
  assert.ok(!/[0O1Il]/.test(a), "no ambiguous characters");
});

test("vault: save/get/list credentials", () => {
  saveCredential("unstop", "me@x.com", "hunter2");
  assert.equal(getCredential("unstop")?.secret, "hunter2");
  assert.ok(listCredentials().some((c) => c.service === "unstop"));
  assert.equal(getCredential("nonexistent"), null);
});

test("otp: extracts codes near otp words and standalone 6-digit", () => {
  assert.equal(extractOtp("Your OTP is 482916. Do not share."), "482916");
  assert.equal(extractOtp("Verification code: 113377"), "113377");
  assert.equal(extractOtp("G-729301 is your Google code"), "729301");
  assert.equal(extractOtp("no numbers here"), null);
});

test("otp: verification link prefers confirm/verify urls", () => {
  const text = `Welcome! https://site.com/privacy verify: https://site.com/verify?token=abc123 bye`;
  assert.equal(extractVerificationLink(text), "https://site.com/verify?token=abc123");
  assert.equal(extractVerificationLink("no links"), null);
});

test("search: parses DuckDuckGo html incl. wrapped urls", () => {
  const html = `<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fjob">Example <b>Job</b></a>
    <a class="result__snippet">A <b>great</b> role</a></div>
    <div class="result results_links"><a class="result__a" href="https://direct.io/x">Direct</a></div>`;
  const r = parseDuckDuckGoHtml(html);
  assert.equal(r.length, 2);
  assert.equal(r[0].url, "https://example.com/job");
  assert.equal(r[0].title, "Example Job");
  assert.equal(r[0].snippet, "A great role");
  assert.equal(r[1].url, "https://direct.io/x");
});

test("tracker: add/list/update/delete + csv export", () => {
  const a = addApplication({ company: "Acme", role: "SDE Intern", portal: "Lever" });
  assert.equal(a.status, "Applied");
  assert.ok(updateApplication(a.id, { status: "Replied" }));
  const all = listApplications();
  assert.ok(all.find((x) => x.id === a.id)?.status === "Replied");
  const csv = trackerCsv();
  assert.match(csv, /Acme/);
  assert.match(csv.split("\n")[0], /^id,date,company/);
  assert.ok(deleteApplication(a.id));
});

test("approvals: approve with edited payload", async () => {
  const card = requestApproval("send_email", "test", { to: "a@b.c", body: "hi" });
  const waiting = waitApproval(card.id, 5000);
  const ok = resolveApproval(card.id, "approved", { to: "a@b.c", body: "edited" });
  assert.ok(ok);
  const res = await waiting;
  assert.equal(res.status, "approved");
  assert.equal((res.payload as any).body, "edited");
});

test("approvals: reject + cannot double-resolve", async () => {
  const card = requestApproval("shell", "test2", { cmd: "ls" });
  assert.ok(resolveApproval(card.id, "rejected"));
  assert.ok(!resolveApproval(card.id, "approved"));
  assert.equal(getApproval(card.id).status, "rejected");
});

test("approvals: expiry resolves as expired", async () => {
  const card = requestApproval("shell", "test3", {});
  const res = await waitApproval(card.id, 60);
  assert.equal(res.status, "expired");
});

test("db: WAL mode + tables exist", () => {
  const mode = (db.prepare("PRAGMA journal_mode").get() as any).journal_mode;
  assert.equal(mode, "wal");
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((t) => t.name);
  for (const t of ["messages", "approvals", "settings", "vault", "applications", "jobs", "signups"]) assert.ok(tables.includes(t), t);
});
