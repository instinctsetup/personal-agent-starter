import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PendingManager } from '../src/agent/pending.js';
import { parseAnswers } from '../src/agent/core.js';

test('confirmation resolves on approve', async () => {
  const pm = new PendingManager();
  const { action, wait } = pm.askConfirmation('mail-send', 'Send x?');
  assert.equal(pm.listPending().length, 1);
  pm.decide(action.id, true);
  assert.equal(await wait, true);
  assert.equal(pm.listPending().length, 0);
});

test('confirmation resolves false on reject', async () => {
  const pm = new PendingManager();
  const { action, wait } = pm.askConfirmation('apply-submit', 'Submit?');
  pm.decide(action.id, false);
  assert.equal(await wait, false);
});

test('unknown confirm id returns undefined', () => {
  const pm = new PendingManager();
  assert.equal(pm.decide('nope', true), undefined);
});

test('questions resolve with parsed answers', async () => {
  const pm = new PendingManager();
  const qs = ['To (email address)', 'Subject', 'Body'];
  const { card, wait } = pm.askQuestions(qs);
  const answers = parseAnswers(qs, 'To: a@b.com\nSubject: Hello\nBody: hi there');
  assert.equal(answers['To (email address)'], 'a@b.com');
  assert.equal(answers['Subject'], 'Hello');
  assert.equal(answers['Body'], 'hi there');
  pm.answerQuestions(card.id, answers);
  assert.deepEqual(await wait, answers);
});

test('positional answers map in order', () => {
  const answers = parseAnswers(['First name', 'Last name'], 'Mahesh\nThakur');
  assert.equal(answers['First name'], 'Mahesh');
  assert.equal(answers['Last name'], 'Thakur');
});
