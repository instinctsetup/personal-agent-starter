import test from "node:test";
import assert from "node:assert/strict";
process.env.AGENT_DATA_DIR = `/tmp/agent-v2-signup-${process.pid}`;
const { recordSignup, listSignups, updateSignupStatus, htmlHasGoogleSso, otpFromInbox, GOOGLE_SSO_SELECTORS } = await import("../src2/signup.js");

test("htmlHasGoogleSso detects common Google-SSO markup", () => {
  assert.ok(htmlHasGoogleSso('<button>Continue with Google</button>'));
  assert.ok(htmlHasGoogleSso('<a href="https://accounts.google.com/o/oauth2/auth">x</a>'));
  assert.ok(!htmlHasGoogleSso('<button>Sign up with email</button>'));
});

test("signup records persist and update", () => {
  const id = recordSignup("example.com", "https://example.com", "google_sso", "me@gmail.com", "pending_verification");
  assert.ok(id > 0);
  assert.equal(listSignups()[0].site, "example.com");
  assert.ok(updateSignupStatus(id, "completed"));
  assert.equal(listSignups()[0].status, "completed");
});

test("otpFromInbox picks a fresh code for the site, ignores stale mail", async () => {
  const now = Date.now();
  const inbox = async () => [
    { subject: "Your code", snippet: "482916 is your verification code", date: new Date(now - 10_000).toISOString() },
    { subject: "Old", snippet: "OTP 111111", date: new Date(now - 3_600_000).toISOString() },
  ];
  assert.equal(await otpFromInbox("example.com", now - 60_000, inbox), "482916");
  assert.equal(await otpFromInbox("example.com", now - 5_000, inbox), null);
});

test("selector list is non-empty strings", () => {
  assert.ok(GOOGLE_SSO_SELECTORS.length >= 4);
  for (const s of GOOGLE_SSO_SELECTORS) assert.equal(typeof s, "string");
});
