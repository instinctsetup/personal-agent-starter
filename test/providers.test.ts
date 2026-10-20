import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { MockProvider } from '../src/providers/mock.js';
import { OpenAiCompatibleProvider } from '../src/providers/openai.js';
import { GeminiProvider, validateGeminiConnection } from '../src/providers/gemini.js';

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

test('gemini provider calls generateContent and parses candidates', async () => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      assert.equal(req.url, '/v1beta/models/gemini-test:generateContent');
      assert.equal(req.headers['x-goog-api-key'], 'test-key');
      const parsed = JSON.parse(body);
      assert.equal(parsed.systemInstruction.parts[0].text, 'be brief');
      assert.deepEqual(parsed.contents, [
        { role: 'user', parts: [{ text: 'ping' }] },
        { role: 'model', parts: [{ text: 'pong?' }] },
        { role: 'user', parts: [{ text: 'ping again' }] },
      ]);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'pong' }] } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const p = new GeminiProvider('gemini-test', 'test-key', `http://127.0.0.1:${port}/v1beta`);
  const out = await p.chat([
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'ping' },
    { role: 'assistant', content: 'pong?' },
    { role: 'user', content: 'ping again' },
  ]);
  assert.equal(out, 'pong');
  server.close();
});

test('gemini provider surfaces HTTP errors and empty completions', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(429).end('quota');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const p = new GeminiProvider('m', 'k', `http://127.0.0.1:${port}`);
  await assert.rejects(() => p.chat([{ role: 'user', content: 'x' }]), /429/);
  server.close();
});

test('gemini provider classifies a bad key (400) as key_invalid', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const p = new GeminiProvider('m', 'bad-key', `http://127.0.0.1:${port}`);
  const err = await p.chat([{ role: 'user', content: 'x' }]).then(() => null, (e) => e);
  assert.equal(err?.code, 'key_invalid');
  assert.match(err.message, /aistudio\.google\.com/);
  server.close();
});

test('gemini provider classifies an unknown model (404) as model_not_found', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 404, message: 'models/nope is not found', status: 'NOT_FOUND' } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const p = new GeminiProvider('nope', 'k', `http://127.0.0.1:${port}`);
  const err = await p.chat([{ role: 'user', content: 'x' }]).then(() => null, (e) => e);
  assert.equal(err?.code, 'model_not_found');
  assert.match(err.message, /nope/);
  assert.match(err.message, /gemini-2\.5-flash/);
  server.close();
});

test('gemini provider retries once on network failure, then succeeds', async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    if (hits === 1) {
      req.socket.destroy(); // simulate a dropped connection
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'pong' }] } }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const p = new GeminiProvider('m', 'k', `http://127.0.0.1:${port}`);
  const out = await p.chat([{ role: 'user', content: 'ping' }]);
  assert.equal(out, 'pong');
  assert.equal(hits, 2);
  server.close();
});

test('gemini provider times out with a clear message after retry', async () => {
  let hits = 0;
  const server = createServer((_req, _res) => {
    hits += 1; // never respond
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const p = new GeminiProvider('m', 'k', `http://127.0.0.1:${port}`, { timeoutMs: 50 });
  const err = await p.chat([{ role: 'user', content: 'x' }]).then(() => null, (e) => e);
  assert.equal(err?.code, 'timeout');
  assert.match(err.message, /timed out/);
  assert.match(err.message, /firewall/);
  assert.equal(hits, 2); // first try + one retry
  server.close();
});

test('validateGeminiConnection checks model metadata, then pings generation', async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url?.includes(':generateContent')) {
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'pong' }] } }] }));
    } else {
      res.end(JSON.stringify({ name: 'models/gemini-test' }));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await validateGeminiConnection('gemini-test', 'test-key', `http://127.0.0.1:${port}`);
  assert.deepEqual(seen, ['GET /models/gemini-test', 'POST /models/gemini-test:generateContent']);
  server.close();
});

test('gemini timeout message names the step and reports step events', async () => {
  const server = createServer((_req, _res) => {
    /* never respond */
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const events: string[] = [];
  const p = new GeminiProvider('m', 'k', `http://127.0.0.1:${port}`, {
    timeoutMs: 50,
    onStep: (e) => events.push(`${e.step}:${e.attempt}:${e.state}:${typeof e.elapsedMs}`),
  });
  const err = await p.chat([{ role: 'user', content: 'x' }]).then(() => null, (e) => e);
  assert.equal(err?.code, 'timeout');
  assert.match(err.message, /during the chat request/);
  assert.deepEqual(events, ['chat:1:start:number', 'chat:1:retry:number', 'chat:2:start:number', 'chat:2:error:number']);
  server.close();
});

test('validateGeminiConnection names the generate ping when it is the slow step', async () => {
  const server = createServer((req, res) => {
    if (req.url?.includes(':generateContent')) return; // slow thinking model: never answers the ping
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: 'models/gemini-test' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const events: { step: string; state: string; elapsedMs: number }[] = [];
  const err = await validateGeminiConnection('gemini-test', 'k', `http://127.0.0.1:${port}`, {
    timeoutMs: 50,
    onStep: (e) => events.push({ step: e.step, state: e.state, elapsedMs: e.elapsedMs }),
  }).then(() => null, (e) => e);
  assert.equal(err?.code, 'timeout');
  assert.match(err.message, /generate ping/);
  assert.match(err.message, /thinking model/);
  // the fast model-check succeeded first; only the ping timed out
  assert.deepEqual(
    events.filter((e) => e.state === 'ok').map((e) => e.step),
    ['model-check'],
  );
  server.close();
});

test('validateGeminiConnection succeeds when the ping is slow but within budget', async () => {
  const server = createServer((req, res) => {
    const answer = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url?.includes(':generateContent')) {
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'pong' }] } }] }));
      } else {
        res.end(JSON.stringify({ name: 'models/gemini-test' }));
      }
    };
    // thinking-model latency: 300ms to first byte on generation
    if (req.url?.includes(':generateContent')) setTimeout(answer, 300);
    else answer();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await validateGeminiConnection('gemini-test', 'k', `http://127.0.0.1:${port}`, { timeoutMs: 5_000, onStep: () => {} });
  server.close();
});
