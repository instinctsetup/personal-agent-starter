import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
process.env.AGENT_DATA_DIR = `/tmp/agent-v2-drive-${process.pid}`;
const { mimeFor, planSync, driveConfigured } = await import("../src2/drive.js");

test("mimeFor maps known extensions, defaults to octet-stream", () => {
  assert.equal(mimeFor("report.pdf"), "application/pdf");
  assert.equal(mimeFor("demo.MP4"), "video/mp4");
  assert.equal(mimeFor("notes.md"), "text/markdown");
  assert.equal(mimeFor("blob.xyz"), "application/octet-stream");
});

test("planSync uploads new and newer files, skips unchanged", () => {
  const dir = mkdtempSync("/tmp/agent-drive-");
  writeFileSync(`${dir}/new.pdf`, "x");
  writeFileSync(`${dir}/same.pdf`, "x");
  writeFileSync(`${dir}/stale.pdf`, "x");
  const now = new Date();
  utimesSync(`${dir}/same.pdf`, now, now);
  utimesSync(`${dir}/stale.pdf`, new Date("2020-01-01"), new Date("2020-01-01"));
  const remote = [
    { id: "1", name: "same.pdf", mimeType: "application/pdf", modifiedTime: new Date(now.getTime() - 5000).toISOString() },
    { id: "2", name: "stale.pdf", mimeType: "application/pdf", modifiedTime: new Date().toISOString() },
  ];
  const plan = planSync(dir, remote);
  assert.deepEqual(plan.upload.map((p) => p.split("/").pop()).sort(), ["new.pdf", "same.pdf"].sort());
  assert.deepEqual(plan.skip.map((p) => p.split("/").pop()), ["stale.pdf"]);
});

test("driveConfigured false without creds", () => {
  assert.equal(driveConfigured(), false);
});
