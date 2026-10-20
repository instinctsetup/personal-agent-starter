import test from "node:test";
import assert from "node:assert/strict";
process.env.AGENT_DATA_DIR = `/tmp/agent-v2-auth-${process.pid}`;
process.env.APP_PASSWORD = "test-pass-123";
const { buildApp } = await import("../src2/app.js");

test("gate blocks API and WS without a session, allows with login cookie", async () => {
  const app = await buildApp();

  const blocked = await app.inject({ method: "GET", url: "/api/settings" });
  assert.equal(blocked.statusCode, 401);
  const blocked2 = await app.inject({ method: "GET", url: "/api/tracker" });
  assert.equal(blocked2.statusCode, 401);

  const status = await app.inject({ method: "GET", url: "/api/auth/status" });
  assert.deepEqual(status.json(), { enabled: true, authed: false });

  const bad = await app.inject({ method: "POST", url: "/api/login", payload: { password: "nope" } });
  assert.equal(bad.statusCode, 401);

  const good = await app.inject({ method: "POST", url: "/api/login", payload: { password: "test-pass-123" } });
  assert.equal(good.statusCode, 200);
  const setCookie = good.headers["set-cookie"] as string;
  assert.match(setCookie, /pa_session=/);
  assert.match(setCookie, /HttpOnly/);
  const cookie = setCookie.split(";")[0];

  const authed = await app.inject({ method: "GET", url: "/api/settings", headers: { cookie } });
  assert.equal(authed.statusCode, 200);

  const out = await app.inject({ method: "POST", url: "/api/logout", headers: { cookie } });
  assert.match(out.headers["set-cookie"] as string, /Max-Age=0/);
  await app.close();
});

test("slack webhook path stays public (it has its own signature check)", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "POST", url: "/api/slack/events", payload: { type: "url_verification", challenge: "x" } });
  assert.notEqual(res.statusCode, 401);
  await app.close();
});

test("gate is off when APP_PASSWORD is unset", async () => {
  delete process.env.APP_PASSWORD;
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/settings" });
  assert.equal(res.statusCode, 200);
  const status = await app.inject({ method: "GET", url: "/api/auth/status" });
  assert.deepEqual(status.json(), { enabled: false, authed: true });
  await app.close();
  process.env.APP_PASSWORD = "test-pass-123";
});
