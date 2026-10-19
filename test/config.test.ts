import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/config.js';

test('settings and secrets persist separately with mode 600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-config-'));
  const store = new Store(dir);
  store.saveSettings({ mail: { user: 'a@gmail.com' } });
  store.saveSecrets({ mailAppPassword: 'supersecretapppassword' });

  const settingsRaw = readFileSync(join(dir, 'settings.json'), 'utf8');
  assert.ok(!settingsRaw.includes('supersecretapppassword'), 'settings file must not contain secrets');
  const mode = statSync(join(dir, 'secrets.json')).mode & 0o777;
  assert.equal(mode, 0o600);

  const reloaded = new Store(dir);
  assert.equal(reloaded.getSettings().mail.user, 'a@gmail.com');
  assert.equal(reloaded.getSecrets().mailAppPassword, 'supersecretapppassword');
  assert.ok(reloaded.hasMailAuth());
});

test('defaults are sane for first run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-config2-'));
  const store = new Store(dir);
  const s = store.getSettings();
  assert.equal(s.setupComplete, false);
  assert.equal(s.model.provider, 'mock');
  assert.equal(s.linkedin.enabled, false);
  assert.equal(s.linkedin.riskAccepted, false);
  assert.equal(s.linkedin.caps.minFeedCheckMinutes, 60);
});
