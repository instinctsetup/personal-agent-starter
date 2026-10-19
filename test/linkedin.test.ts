import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/config.js';
import { LinkedInTools, LinkedInStopped, linkedinRiskNote } from '../src/tools/linkedin.js';

function makeTools(enabled: boolean, riskAccepted: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-li-'));
  const store = new Store(dir);
  store.saveSettings({ linkedin: { ...store.getSettings().linkedin, enabled, riskAccepted } });
  return new LinkedInTools(store, dir);
}

test('off by default with a clear reason', () => {
  const li = makeTools(false, false);
  const gate = li.isEnabled();
  assert.equal(gate.ok, false);
  assert.match(gate.reason!, /off/i);
});

test('risk note must be accepted before enabling works', () => {
  const li = makeTools(true, false);
  const gate = li.isEnabled();
  assert.equal(gate.ok, false);
  assert.match(gate.reason!, /risk note/i);
});

test('risk note mentions LinkedIn terms', () => {
  assert.match(linkedinRiskNote(), /terms/i);
  assert.match(linkedinRiskNote(), /own risk/i);
});

test('feed pacing: second check within the interval is refused', () => {
  const li = makeTools(true, true);
  li.checkCap('feed');
  // simulate a completed check by writing state through the private path
  (li as unknown as { bumpCap: (k: string) => void }).bumpCap('feed');
  assert.throws(() => li.checkCap('feed'), LinkedInStopped);
});

test('action pacing: actions within the interval are refused', () => {
  const li = makeTools(true, true);
  li.checkCap('action');
  (li as unknown as { bumpCap: (k: string) => void }).bumpCap('action');
  assert.throws(() => li.checkCap('action'), LinkedInStopped);
});

test('daily caps block after the limit', () => {
  const li = makeTools(true, true);
  const caps = { feedChecksPerDay: 1, actionsPerDay: 1, minFeedCheckMinutes: 0, minActionMinutes: 0 };
  (li as unknown as { store: Store }).store.saveSettings({ linkedin: { enabled: true, riskAccepted: true, caps } });
  li.checkCap('feed');
  (li as unknown as { bumpCap: (k: string) => void }).bumpCap('feed');
  let err: unknown;
  try { li.checkCap('feed'); } catch (e) { err = e; }
  assert.ok(err instanceof LinkedInStopped);
  assert.match((err as Error).message, /cap/i);
});
