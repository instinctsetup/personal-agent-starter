import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, registerSecret } from '../src/util/log.js';

test('registered secrets are masked', () => {
  registerSecret('my-secret-app-password');
  assert.equal(redact('login failed for my-secret-app-password ok'), 'login failed for [redacted] ok');
});

test('telegram bot token pattern is masked', () => {
  assert.equal(redact('error with 123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx here'), 'error with [redacted] here');
});

test('github PAT pattern is masked', () => {
  assert.equal(redact('ghp_abcdefghijklmnopqrstuvwxyz1234 leaked'), '[redacted] leaked');
});
