/** Build identity: the app must always be able to say which commit it runs. */
import test from "node:test";
import assert from "node:assert/strict";
import { appVersion } from "../src2/version.js";

test("appVersion reports a semver and a commit hash inside a git checkout", () => {
  const v = appVersion();
  assert.match(v.version, /^\d+\.\d+/);
  assert.match(v.commit, /^[0-9a-f]{7,}$/, "git rev-parse works in the repo");
  assert.match(v.commitDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Date.parse(v.startedAt) > 0);
});
