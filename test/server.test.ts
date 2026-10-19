import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.js';
import type { Server } from 'node:http';

let server: Server;
let base: string;
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pa-server-'));
  writeFileSync(join(dir, 'resume.pdf'), '%PDF-1.4 fake');
  const started = startServer(0, '127.0.0.1', dir);
  server = started.server;
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => server.close());

const post = (path: string, body?: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

test('status endpoint reports setup state and honest labels', async () => {
  const res = await fetch(base + '/api/status');
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.setupComplete, false);
  assert.equal(data.model.offline, true);
  assert.equal(data.linkedin.enabled, false);
  assert.ok(data.linkedin.riskNote.includes('terms'));
  assert.ok(data.profileLabels.firstName);
});

test('secrets save via API and never echo back', async () => {
  const res = await post('/api/settings', {
    settings: { mail: { user: 'me@gmail.com' } },
    secrets: { mailAppPassword: 'abcdefgh12345678' },
  });
  assert.equal(res.status, 200);
  const data = await (await fetch(base + '/api/settings')).json();
  assert.equal(data.secretsSet.mailAppPassword, true);
  assert.ok(!JSON.stringify(data).includes('abcdefgh12345678'));
});

test('profile save/get round trip', async () => {
  await post('/api/profile', { firstName: 'Mahesh', lastName: 'Thakur', email: 'a@b.com', resumePath: join(dir, 'resume.pdf') });
  const prof = await (await fetch(base + '/api/profile')).json();
  assert.equal(prof.firstName, 'Mahesh');
  assert.equal(prof.email, 'a@b.com');
});

async function waitForEntry(pred: (e: Record<string, never>) => boolean, timeoutMs = 5000) {
  const start = Date.now();
  let after = 0;
  while (Date.now() - start < timeoutMs) {
    const data = await (await fetch(base + `/api/chat/history?after=${after}`)).json();
    for (const e of data.entries) {
      after = Math.max(after, e.n);
      if (pred(e)) return e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for chat entry');
}

test('chat works with the offline mock provider', async () => {
  await post('/api/chat', { text: 'hello agent' });
  const e = await waitForEntry((x) => (x as { role: string; text: string }).role === 'assistant' && (x as { text: string }).text.includes('Mock reply'));
  assert.ok(e);
});

test('help command lists capabilities without a model', async () => {
  await post('/api/chat', { text: 'help' });
  const e = await waitForEntry((x) => (x as { text: string }).text?.includes('check mail'));
  assert.ok(e);
});

test('send-mail flow is gated by a confirmation', async () => {
  await post('/api/chat', { text: 'send mail' });
  const q = await waitForEntry((x) => (x as { card?: { type: string } }).card?.type === 'questions');
  assert.ok((q as { card: { questions: string[] } }).card.questions.join(' ').includes('To'));

  // answering the questions opens a confirmation card
  await post('/api/chat', { text: 'To: bob@example.com\nSubject: Hi Bob\nBody: hello bob' });
  const c = await waitForEntry((x) => (x as { card?: { type: string; kind: string } }).card?.type === 'confirm' && (x as { card: { kind: string } }).card.kind === 'mail-send');
  const id = (c as { card: { id: string } }).card.id;

  // rejecting resolves the flow without sending (no SMTP configured anyway)
  const res = await post('/api/confirm', { id, approved: false });
  assert.equal(res.status, 200);
  const done = await waitForEntry((x) => (x as { text: string }).text?.includes('not sending'));
  assert.ok(done);
});

test('applications endpoint returns an empty log cleanly', async () => {
  const data = await (await fetch(base + '/api/applications')).json();
  assert.deepEqual(data.entries, []);
});

test('mail without credentials fails with a clear message', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'pa-server2-'));
  const started2 = startServer(0, '127.0.0.1', dir2);
  const s2 = started2.server;
  await new Promise<void>((r) => s2.once('listening', r));
  const port = (s2.address() as { port: number }).port;
  const r = await fetch(`http://127.0.0.1:${port}/api/test/mail`, { method: 'POST' });
  const data = await r.json();
  assert.equal(data.ok, false);
  assert.ok(data.detail.includes('not connected'));
  s2.close();
});
