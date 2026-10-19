import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJobApplication, readApplicationLog } from '../src/tools/apply.js';
import { EMPTY_PROFILE } from '../src/tools/profile.js';

let server: Server;
let base: string;
let dir: string;
let resumePath: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pa-apply-'));
  resumePath = join(dir, 'resume.pdf');
  writeFileSync(resumePath, '%PDF-1.4 fake resume');
  const html = readFileSync(join(process.cwd(), 'test/fixtures/job-form.html'), 'utf8');
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

const profile = {
  ...EMPTY_PROFILE,
  firstName: 'Mahesh',
  lastName: 'Thakur',
  email: 'mahesh@example.com',
  phone: '+919999999999',
  resumePath: '',
  linkedin: 'https://linkedin.com/in/example',
  location: 'Remote',
};
profile.resumePath = '';

test('cancelled when the user declines the confirmation', async () => {
  const p = { ...profile, resumePath };
  let askedFacts = 0;
  const result = await runJobApplication(
    { url: base + '/job', profile: p, dataDir: dir },
    {
      askFacts: async (qs) => {
        askedFacts++;
        assert.ok(qs.some((q) => /why/i.test(q)), 'unknown required textarea must be asked, not invented');
        return Object.fromEntries(qs.map((q) => [q, 'Because I like distributed systems.']));
      },
      confirmSubmit: async (summary) => {
        assert.ok(summary.includes('Mahesh'), 'summary should show filled values');
        return false; // user cancels
      },
    },
  );
  assert.equal(result.status, 'cancelled');
  assert.equal(askedFacts, 1);
  const log = readApplicationLog(dir);
  assert.ok(log.some((e) => e.status === 'cancelled'));
});

test('submits after confirmation and fills only profile facts', async () => {
  const p = { ...profile, resumePath };
  const result = await runJobApplication(
    { url: base + '/job', profile: p, dataDir: dir },
    {
      askFacts: async (qs) => Object.fromEntries(qs.map((q) => [q, 'answer from user'])),
      confirmSubmit: async () => true,
    },
  );
  assert.equal(result.status, 'submitted', result.error);
  const filledLabels = result.filled.map((f) => f.label).join(' | ');
  assert.match(filledLabels, /First name/);
  assert.match(filledLabels, /resume/i);
  const log = readApplicationLog(dir);
  assert.ok(log.some((e) => e.status === 'submitted'));
});

test('needs-facts when the user cannot answer', async () => {
  const p = { ...profile, resumePath };
  const result = await runJobApplication(
    { url: base + '/job', profile: p, dataDir: dir },
    {
      askFacts: async () => ({}), // user bails
      confirmSubmit: async () => true,
    },
  );
  assert.equal(result.status, 'needs-facts');
  assert.ok(result.missing.length > 0);
});
