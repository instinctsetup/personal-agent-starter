import test from "node:test";
import assert from "node:assert/strict";
process.env.AGENT_DATA_DIR = `/tmp/agent-v2-boards-${process.pid}`;
delete process.env.APP_PASSWORD;
const { buildApp } = await import("../src2/app.js");
const { ensureBoard, rotateShareToken, getBoard, boardData, renderBoardPage } = await import("../src2/boards.js");
const { addApplication } = await import("../src2/tracker.js");
const { handleUserMessage } = await import("../src2/agent2.js");
const { onEvent } = await import("../src2/bus.js");

async function runChat(text: string) {
  const evs: any[] = [];
  const off = onEvent((e) => evs.push(e));
  try { await handleUserMessage(text); } finally { off(); }
  return evs;
}

test("pipeline board data: columns, cards, stats from the tracker", async () => {
  addApplication({ company: "Acme", role: "SDE", portal: "unstop", status: "Applied", url: "https://x.example/job1" });
  addApplication({ company: "Beta", role: "Intern", status: "Replied" });
  addApplication({ company: "Old Co", status: "Rejected" });
  const d = (await boardData("pipeline")) as any;
  assert.equal(d.kind, "pipeline");
  const total = d.stats.find((s: any) => s.label === "Total");
  assert.equal(total.value, 3);
  const applied = d.columns.find((c: any) => c.name === "Applied");
  assert.equal(applied.cards[0].company, "Acme");
  assert.equal(applied.cards[0].days, 0);
  const rate = d.stats.find((s: any) => s.label === "Response rate");
  assert.equal(rate.value, "33%");
});

test("board data is live: a new application appears without recreating the board", async () => {
  const b = ensureBoard("pipeline");
  const before = (await boardData(b.kind)) as any;
  const n0 = before.stats.find((s: any) => s.label === "Total").value;
  addApplication({ company: "Fresh Inc", status: "Scouted" });
  const after = (await boardData(b.kind)) as any;
  assert.equal(after.stats.find((s: any) => s.label === "Total").value, n0 + 1);
  const scouted = after.columns.find((c: any) => c.name === "Scouted");
  assert.ok(scouted.cards.some((c: any) => c.company === "Fresh Inc"));
});

test("rendered page carries title, live poller and no unescaped HTML", async () => {
  addApplication({ company: "<script>alert(1)</script>", status: "Applied" });
  const b = ensureBoard("pipeline");
  const html = renderBoardPage(b, b.share_token);
  assert.match(html, /Job Application Pipeline/);
  assert.match(html, /setTimeout\(tick,4000\)/);
  const d = (await boardData("pipeline")) as any;
  const raw = JSON.stringify(d);
  assert.ok(raw.includes("<script>")); // data layer is raw...
  // ...but the page escapes through escH at render time (client-side) - the server template must not interpolate raw data
  assert.ok(!html.includes("alert(1)"));
});

test("HTTP: owner session not needed locally, JSON + HTML serve", async () => {
  const app = await buildApp();
  const b = ensureBoard("pipeline");
  const html = await app.inject({ method: "GET", url: `/boards/${b.id}?k=${b.share_token}` });
  assert.equal(html.statusCode, 200);
  assert.match(html.body, /Job Application Pipeline/);
  const json = await app.inject({ method: "GET", url: `/boards/${b.id}.json?k=${b.share_token}` });
  assert.equal(json.statusCode, 200);
  assert.equal(json.json().kind, "pipeline");
  const missing = await app.inject({ method: "GET", url: "/boards/nope123" });
  assert.equal(missing.statusCode, 404);
  await app.close();
});

test("HTTP with APP_PASSWORD: share token opens, wrong token blocked, rotation kills old links", async () => {
  process.env.APP_PASSWORD = "board-pass";
  try {
    const app = await buildApp();
    const b = ensureBoard("overview");
    const open = await app.inject({ method: "GET", url: `/boards/${b.id}?k=${b.share_token}` });
    assert.equal(open.statusCode, 200);
    const openJson = await app.inject({ method: "GET", url: `/boards/${b.id}.json?k=${b.share_token}` });
    assert.equal(openJson.statusCode, 200);
    const denied = await app.inject({ method: "GET", url: `/boards/${b.id}?k=wrong` });
    assert.equal(denied.statusCode, 401);
    const anon = await app.inject({ method: "GET", url: `/boards/${b.id}` });
    assert.equal(anon.statusCode, 401);
    // rotate: old token dies, new token works
    const rotated = rotateShareToken(b.id)!;
    assert.notEqual(rotated.share_token, b.share_token);
    const stale = await app.inject({ method: "GET", url: `/boards/${b.id}?k=${b.share_token}` });
    assert.equal(stale.statusCode, 401);
    const fresh = await app.inject({ method: "GET", url: `/boards/${b.id}?k=${rotated.share_token}` });
    assert.equal(fresh.statusCode, 200);
    // owner session still works without any token
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "board-pass" } });
    const cookie = (login.headers["set-cookie"] as string).split(";")[0];
    const owner = await app.inject({ method: "GET", url: `/boards/${b.id}`, headers: { cookie } });
    assert.equal(owner.statusCode, 200);
    await app.close();
  } finally {
    delete process.env.APP_PASSWORD;
  }
});

test("overview board: stats + recent activity, no secrets", async () => {
  const d = (await boardData("overview")) as any;
  assert.ok(d.stats.some((s: any) => s.label === "Applications"));
  assert.ok(Array.isArray(d.events));
  assert.ok(!JSON.stringify(d).match(/password|secret_enc/i));
});

test("inbox board degrades gracefully when mail is not connected", async () => {
  const d = (await boardData("inbox")) as any;
  assert.equal(d.configured, false);
  assert.deepEqual(d.messages, []);
});

test("chat: 'board pipeline' replies with a working link; 'boards' lists; 'unshare' rotates", async () => {
  const app = await buildApp();
  const evs = await runChat("board pipeline");
  const text = evs.filter((e) => e.kind === "text").map((e) => e.text).join("\n");
  const m = text.match(/http:\/\/localhost:\d+\/boards\/([a-f0-9]+)\?k=([a-f0-9]+)/);
  assert.ok(m, `expected a board link in: ${text}`);
  const served = await app.inject({ method: "GET", url: `/boards/${m[1]}?k=${m[2]}` });
  assert.equal(served.statusCode, 200);

  const evs2 = await runChat("boards");
  const text2 = evs2.filter((e) => e.kind === "text").map((e) => e.text).join("\n");
  assert.match(text2, /pipeline:/);
  assert.match(text2, /overview:/);

  const before = getBoard(m[1])!;
  const evs3 = await runChat("unshare pipeline");
  const text3 = evs3.filter((e) => e.kind === "text").map((e) => e.text).join("\n");
  assert.match(text3, /old pipeline link is dead/i);
  assert.notEqual(getBoard(m[1])!.share_token, before.share_token);
  await app.close();
});
