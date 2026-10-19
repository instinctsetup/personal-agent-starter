import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchProfileKey, pickOption, ProfileStore } from '../src/tools/profile.js';

test('field matching covers common labels', () => {
  assert.equal(matchProfileKey('First name *'), 'firstName');
  assert.equal(matchProfileKey('Last Name'), 'lastName');
  assert.equal(matchProfileKey('Email address'), 'email');
  assert.equal(matchProfileKey('Phone number'), 'phone');
  assert.equal(matchProfileKey('Upload your resume'), 'resumePath');
  assert.equal(matchProfileKey('CV'), 'resumePath');
  assert.equal(matchProfileKey('Cover letter'), 'coverLetter');
  assert.equal(matchProfileKey('LinkedIn profile URL'), 'linkedin');
  assert.equal(matchProfileKey('GitHub username'), 'github');
  assert.equal(matchProfileKey('Expected salary'), 'salaryExpectation');
  assert.equal(matchProfileKey('Expected stipend'), 'salaryExpectation');
  assert.equal(matchProfileKey('Notice period'), 'noticePeriod');
  assert.equal(matchProfileKey('Are you authorized to work in India?'), 'workAuthorization');
  assert.equal(matchProfileKey('University/College'), 'university');
  assert.equal(matchProfileKey('Graduation year'), 'graduationYear');
});

test('unknown labels do not match (never invent)', () => {
  assert.equal(matchProfileKey('Why do you want to work here?'), undefined);
  assert.equal(matchProfileKey('Tell us about a project'), undefined);
});

test('option picking is exact-then-contains, never a guess', () => {
  assert.equal(pickOption('India', ['USA', 'India', 'UK']), 'India');
  assert.equal(pickOption('bengaluru', ['Remote', 'Bengaluru (Hybrid)']), 'Bengaluru (Hybrid)');
  assert.equal(pickOption('Atlantis', ['USA', 'India']), undefined);
});

test('profile store persists with mode 600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-profile-'));
  const ps = new ProfileStore(dir);
  ps.save({ firstName: 'Mahesh', email: 'a@b.com' });
  assert.equal((statSync(ps.path).mode & 0o777), 0o600);
  const again = new ProfileStore(dir);
  assert.equal(again.get().firstName, 'Mahesh');
  assert.equal(again.get().email, 'a@b.com');
});
