import test from "node:test";
import assert from "node:assert/strict";
process.env.AGENT_DATA_DIR = `/tmp/agent-v2-mail-${process.pid}`;
const { renderColdMail, mailConfigured } = await import("../src2/mail.js");

test("cold-mail template renders vars, keeps unknown placeholders visible", () => {
  const out = renderColdMail("Hi {{name}}, I admire {{company}}. {{unknown}}", { name: "Priya", company: "Acme" });
  assert.equal(out, "Hi Priya, I admire Acme. {{unknown}}");
});

test("mailConfigured is false without credentials", () => {
  assert.equal(mailConfigured(), false);
});
