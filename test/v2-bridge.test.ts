import test from "node:test";
import assert from "node:assert/strict";
process.env.AGENT_DATA_DIR = `/tmp/agent-v2-bridge-${process.pid}`;
const { handleSlackEvent, verifySlackSignature, bridgeTargets } = await import("../src2/bridge.js");
import { createHmac } from "node:crypto";

test("slack url_verification echoes challenge", () => {
  assert.deepEqual(handleSlackEvent({ type: "url_verification", challenge: "abc123" }), { challenge: "abc123" });
});

test("slack message event registers a bridge target and acks", () => {
  const r = handleSlackEvent({ type: "event_callback", event: { type: "message", text: "hello", channel: "C123" } });
  assert.deepEqual(r, { ok: true });
  assert.ok(bridgeTargets().some((t) => t.kind === "slack" && t.chat === "C123"));
});

test("bot messages are ignored", () => {
  const before = bridgeTargets().length;
  handleSlackEvent({ type: "event_callback", event: { type: "message", text: "hi", channel: "C999", bot_id: "B1" } });
  assert.equal(bridgeTargets().length, before);
});

test("slack signature verification", () => {
  const secret = "test-secret";
  const ts = String(Math.floor(Date.now() / 1000));
  const body = '{"type":"url_verification"}';
  const sig = "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
  assert.ok(verifySlackSignature(secret, ts, body, sig));
  assert.ok(!verifySlackSignature(secret, ts, body, "v0=deadbeef"));
  assert.ok(!verifySlackSignature(secret, String(Math.floor(Date.now() / 1000) - 1000), body, sig)); // replay
});
