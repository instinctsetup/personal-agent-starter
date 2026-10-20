/** Stage v3.2: durable plans (checkpoints, retries, self-correction, resume) + per-action daily caps. */
import test from "node:test";
import assert from "node:assert/strict";
process.env.AGENT_DATA_DIR = `/tmp/agent-v2-plans-${process.pid}`;
process.env.AGENT_STATUS_TICK_MS = "50";
delete process.env.APP_PASSWORD;
const { createPlan, getPlan, listPlans, cancelPlan, runPlan } = await import("../src2/plans.js");
const { checkCap, recordAction, setCap, capStatus } = await import("../src2/caps.js");

test("plan runner: happy path checkpoints every step and finishes", async () => {
  const p = createPlan("test goal", ["step one", "step two", "step three"]);
  const seen: string[] = [];
  const done = await runPlan(p, async (cmd) => { seen.push(cmd); return { ok: true }; });
  assert.equal(done.status, "done");
  assert.deepEqual(seen, ["step one", "step two", "step three"]);
  const stored = getPlan(p.id)!;
  assert.equal(stored.status, "done");
  assert.ok(stored.steps.every((s) => s.status === "done" && s.attempts === 1));
});

test("plan runner: a flaky step is retried once and succeeds; attempts are recorded", async () => {
  const p = createPlan("flaky", ["good", "flaky", "good2"]);
  let flakyCalls = 0;
  const done = await runPlan(p, async (cmd) => {
    if (cmd === "flaky" && ++flakyCalls === 1) return { ok: false, error: "transient" };
    return { ok: true };
  });
  assert.equal(done.status, "done");
  assert.equal(flakyCalls, 2);
  assert.equal(done.steps[1].attempts, 2);
  assert.equal(done.steps[1].status, "done");
});

test("plan runner: hard failure pauses at the step; resume continues from the checkpoint, never re-runs done steps", async () => {
  const p = createPlan("resume me", ["a", "b-broken", "c"]);
  const ran: string[] = [];
  const first = await runPlan(p, async (cmd) => (cmd === "b-broken" ? { ok: false, error: "boom" } : (ran.push(cmd), { ok: true })));
  assert.equal(first.status, "paused");
  assert.equal(first.steps[1].status === "failed" || first.steps[1].status === "pending", true);
  assert.deepEqual(ran, ["a"]);
  // fix the world, resume: "a" must NOT re-run
  const second = await runPlan(getPlan(p.id)!, async (cmd) => (ran.push(cmd), { ok: true }));
  assert.equal(second.status, "done");
  assert.deepEqual(ran, ["a", "b-broken", "c"]);
});

test("plan runner: self-correction replaces a twice-failed step with the fixer's alternative", async () => {
  const p = createPlan("fix me", ["badcmd"]);
  const ran: string[] = [];
  const done = await runPlan(
    p,
    async (cmd) => { ran.push(cmd); return cmd === "bettercmd" ? { ok: true } : { ok: false, error: "unknown command" }; },
    async (goal, step) => {
      assert.equal(step.cmd, "badcmd");
      assert.equal(step.error, "unknown command");
      return "bettercmd";
    },
  );
  assert.equal(done.status, "done");
  assert.deepEqual(ran, ["badcmd", "badcmd", "bettercmd"]); // two tries, then the correction
  assert.equal(done.steps[0].cmd, "bettercmd");
});

test("plan runner: fixer returning the same command does not loop; plan pauses", async () => {
  const p = createPlan("loop guard", ["bad"]);
  let calls = 0;
  const done = await runPlan(p, async () => (++calls, { ok: false, error: "x" } as const), async () => "bad");
  assert.equal(done.status, "paused");
  assert.equal(calls, 2); // no third attempt with an identical command
});

test("plans: list and cancel", async () => {
  const p = createPlan("cancel me", ["x", "y"]);
  assert.ok(listPlans().some((x) => x.id === p.id));
  const c = cancelPlan(p.id)!;
  assert.equal(c.status, "cancelled");
  assert.ok(c.steps.every((s) => s.status === "skipped"));
  // cancelled plans never execute
  let ran = 0;
  const r = await runPlan(getPlan(p.id)!, async () => (++ran, { ok: true } as const));
  assert.equal(ran, 0);
  assert.equal(r.status, "cancelled");
});

test("caps: default caps, recording, denial at the limit, custom raise, day boundary keys", () => {
  setCap("send_mail", 10); // reset from any prior test bleed
  const before = checkCap("send_mail");
  assert.equal(before.cap, 10);
  const used0 = before.used;
  recordAction("send_mail", "a@x.com");
  recordAction("send_mail", "b@x.com");
  const mid = checkCap("send_mail");
  assert.equal(mid.used, used0 + 2);
  setCap("send_mail", mid.used); // cap == used -> denied
  const denied = checkCap("send_mail");
  assert.equal(denied.allowed, false);
  setCap("send_mail", mid.used + 5);
  assert.equal(checkCap("send_mail").allowed, true);
  assert.ok(capStatus().some((c) => c.action === "apply"));
});

test("caps: unknown action defaults to zero (deny everything not explicitly capped)", () => {
  const c = checkCap("shell_exec");
  assert.equal(c.cap, 0);
  assert.equal(c.allowed, false);
});

test("plan runner: permanent failures (user said no / cap) are never retried and never re-planned", async () => {
  const p = createPlan("respect the no", ["bad"]);
  let calls = 0;
  let fixerCalls = 0;
  const done = await runPlan(
    p,
    async () => (++calls, { ok: false, error: "send rejected by user", permanent: true } as const),
    async () => (++fixerCalls, "altcmd"),
  );
  assert.equal(done.status, "paused");
  assert.equal(calls, 1, "no retry on a permanent failure");
  assert.equal(fixerCalls, 0, "no self-correction around a user's no");
});
