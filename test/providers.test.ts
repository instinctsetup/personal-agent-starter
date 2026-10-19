import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { MockProvider } from '../src/providers/mock.js';
import { OpenAiCompatibleProvider } from '../src/providers/openai.js';

test('mock provider is offline and deterministic', async () => {
  const p = new MockProvider();
  assert.equal(p.offline, true);
  const a = await p.chat([{ role: 'user', content: 'hello there' }]);
  const b = await p.chat([{ role: 'user', content: 'hello there' }]);
  assert.equal(a, b);
  assert.ok(a.includes('hello there'));
});

test('mock provider summarize mode', async () => {
  const p = new MockProvider();
  const out = await p.chat([
    { role: 'system', content: 'Summarize this email in one or two short sentences.' },
    { role: 'user', content: 'Your interview is on Friday at 3pm. Bring your ID. See you there.' },
  ]);
  assert.ok(out.startsWith('Summary:'));
  assert.ok(out.includes('Friday'));
});

test('openai-compatible provider talks to any compatible endpoint', async () => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      assert.equal(req.headers.authorization, 'Bearer test-key');
      assert.equal(parsed.model, 'test-model');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const p = new OpenAiCompatibleProvider(`http://127.0.0.1:${port}/v1`, 'test-model', 'test-key');
  const out = await p.chat([{ role: 'user', content: 'ping' }]);
  assert.equal(out, 'pong');
  server.close();
});

test('openai-compatible provider surfaces HTTP errors', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(401).end('bad key');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const p = new OpenAiCompatibleProvider(`http://127.0.0.1:${port}/v1`, 'm', 'k');
  await assert.rejects(() => p.chat([{ role: 'user', content: 'x' }]), /401/);
  server.close();
});
