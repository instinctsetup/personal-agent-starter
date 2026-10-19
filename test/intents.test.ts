import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent } from '../src/agent/intents.js';

test('help', () => {
  assert.equal(parseIntent('help').name, 'help');
  assert.equal(parseIntent('what can you do').name, 'help');
});

test('mail intents', () => {
  assert.deepEqual(parseIntent('check mail'), { name: 'mail.list', unseenOnly: false });
  assert.deepEqual(parseIntent('unread mail'), { name: 'mail.list', unseenOnly: true });
  assert.deepEqual(parseIntent('mail search stripe'), { name: 'mail.search', query: 'stripe' });
  assert.deepEqual(parseIntent('search my inbox for invoice'), { name: 'mail.search', query: 'invoice' });
  assert.deepEqual(parseIntent('summarize mail'), { name: 'mail.summarize', count: 3 });
  assert.deepEqual(parseIntent('send mail'), { name: 'mail.send' });
  assert.deepEqual(parseIntent('compose an email'), { name: 'mail.send' });
});

test('apply intent extracts url', () => {
  const i = parseIntent('apply to this https://jobs.example.com/posting/123.');
  assert.equal(i.name, 'apply');
  if (i.name === 'apply') assert.equal(i.url, 'https://jobs.example.com/posting/123');
});

test('linkedin intents', () => {
  assert.equal(parseIntent('linkedin feed').name, 'linkedin.feed');
  assert.equal(parseIntent('linkedin login').name, 'linkedin.login');
  const a = parseIntent('apply https://www.linkedin.com/jobs/view/123');
  assert.equal(a.name, 'linkedin.apply');
  const m = parseIntent('linkedin message https://www.linkedin.com/in/jane: Hi Jane, great post');
  assert.equal(m.name, 'linkedin.message');
  if (m.name === 'linkedin.message') assert.equal(m.text, 'Hi Jane, great post');
});

test('telegram intents', () => {
  assert.equal(parseIntent('telegram channels').name, 'telegram.channels');
  assert.equal(parseIntent('telegram status').name, 'telegram.status');
});

test('fallback chat', () => {
  assert.equal(parseIntent('how are you today').name, 'chat');
});

test('applications log intent', () => {
  assert.equal(parseIntent('my applications').name, 'applications');
  assert.equal(parseIntent('application log').name, 'applications');
});
