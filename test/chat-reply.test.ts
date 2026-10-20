/** Regression: a chat turn must always end in a visible reply or error, even with slow / thinking-model Gemini behaviour. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

process.env.AGENT_DATA_DIR = `/tmp/agent-chat-reply-test-${process.pid}`;
process.env.AGENT_STATUS_TICK_MS = '50';
process.env.AGENT_CHAT_DEADLINE_MS = '600';

const { GeminiProvider, parseGeminiResponse } = await import('../src/providers/gemini.js');
const { handleUserMessage, withProgress } = await import('../src2/agent2.js');
const { onEvent } = await import('../src2/bus.js');
const { setSetting } = await import('../src2/db.js');

type Handler = (body: any, res: ServerResponse, req: IncomingMessage) => void;
async function mockGemini(handler: Handler) {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      bodies.push(body);
      handler(body, res, req);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1beta`, bodies, close: () => { server.closeAllConnections(); server.close(); } };
}
const json = (res: ServerResponse, obj: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

test('parseGeminiResponse skips thought parts and reads the answer', () => {
  const r = parseGeminiResponse({
    candidates: [{ content: { parts: [{ text: 'reasoning...', thought: true }, { text: 'Hello!' }, { text: '' }] }, finishReason: 'STOP' }],
  });
  assert.equal(r.text, 'Hello!');
});

test('thinking model: thought-only MAX_TOKENS reply is retried with a bigger budget', async () => {
  let calls = 0;
  const m = await mockGemini((_b, res) => {
    calls++;
    if (calls === 1) return json(res, { candidates: [{ content: { parts: [{ text: '', thought: true }] }, finishReason: 'MAX_TOKENS' }] });
    json(res, { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'Hi there' }] }, finishReason: 'STOP' }] });
  });
  try {
    const p = new GeminiProvider('gemini-3.8-flash', 'k', m.url, { timeoutMs: 2000, attempts: 1 });
    assert.equal(await p.chat([{ role: 'user', content: 'hi' }]), 'Hi there');
    assert.equal(calls, 2);
    assert.ok(m.bodies[1].generationConfig.maxOutputTokens > m.bodies[0].generationConfig.maxOutputTokens);
    assert.ok(m.bodies[0].generationConfig.maxOutputTokens >= 2048, 'default budget leaves room after thinking');
    assert.equal(m.bodies[0].generationConfig.thinkingConfig.thinkingLevel, 'low');
  } finally { m.close(); }
});

test('still-empty MAX_TOKENS reply gives a clear error, not silence', async () => {
  const m = await mockGemini((_b, res) => json(res, { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }));
  try {
    const p = new GeminiProvider('gemini-3.8-flash', 'k', m.url, { timeoutMs: 2000, attempts: 1 });
    await assert.rejects(() => p.chat([{ role: 'user', content: 'hi' }]), /empty reply.*MAX_TOKENS/s);
  } finally { m.close(); }
});

test('model that rejects thinkingConfig is retried without it', async () => {
  const m = await mockGemini((b, res) => {
    if (b.generationConfig.thinkingConfig) return json(res, { error: { message: 'Unknown name "thinkingLevel": thinking is not supported' } }, 400);
    json(res, { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
  });
  try {
    const p = new GeminiProvider('some-model', 'k', m.url, { timeoutMs: 2000, attempts: 1 });
    assert.equal(await p.chat([{ role: 'user', content: 'hi' }]), 'ok');
    assert.equal(m.bodies.length, 2);
  } finally { m.close(); }
});

test('response whose body stalls after headers times out instead of hanging', async () => {
  const m = await mockGemini((_b, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"candi'); });
  try {
    const p = new GeminiProvider('gemini-3.8-flash', 'k', m.url, { timeoutMs: 300, attempts: 1 });
    await assert.rejects(() => p.chat([{ role: 'user', content: 'hi' }]), /stalled/);
  } finally { m.close(); }
});

async function runChat(text: string) {
  const events: any[] = [];
  const off = onEvent((e) => events.push(e));
  await handleUserMessage(text);
  off();
  return events;
}
const visible = (evs: any[]) => evs.filter((e) => e.role !== 'user' && (e.kind === 'text' || e.kind === 'error'));

test('chat: "check my email" without mail connected says how to connect it', async () => {
  const out = visible(await runChat('check my email'));
  assert.equal(out.length, 1);
  assert.match(out[0].text, /connect email/);
});

test('chat: unknown request with no model connected explains what to do', async () => {
  const out = visible(await runChat('what is the capital of France'));
  assert.equal(out.length, 1);
  assert.match(out[0].text, /connect gemini/);
});

test('chat: "hi" with a thinking Gemini shows waiting status, then the reply', async () => {
  const m = await mockGemini((_b, res) => setTimeout(() => json(res, { candidates: [{ content: { parts: [{ text: 'hmm', thought: true }, { text: 'Hello Mahesh' }] }, finishReason: 'STOP' }] }), 200));
  setSetting('model_provider', 'gemini'); setSetting('model_api_key', 'k'); setSetting('model', 'gemini-3.8-flash');
  process.env.GEMINI_TEST_BASE = m.url;
  try {
    // route the provider at the mock by swapping global fetch's host
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((u: any, init: any) => realFetch(String(u).replace('https://generativelanguage.googleapis.com/v1beta', m.url), init)) as typeof fetch;
    const evs = await runChat('hi').finally(() => { globalThis.fetch = realFetch; });
    assert.ok(evs.some((e) => e.kind === 'status' && e.state === 'waiting'));
    assert.ok(evs.some((e) => e.kind === 'status' && e.state === 'done'));
    const out = visible(evs);
    assert.equal(out.length, 2); // race winner note + the reply
    assert.match(out[0].text, /answered first/);
    assert.equal(out[1].text, 'Hello Mahesh');
  } finally { m.close(); }
});

test('chat: a model that never answers ends in a visible error at the deadline', async () => {
  const m = await mockGemini(() => { /* never respond */ });
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((u: any, init: any) => realFetch(String(u).replace('https://generativelanguage.googleapis.com/v1beta', m.url), init)) as typeof fetch;
  try {
    const evs = await runChat('hello');
    const out = visible(evs);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'error');
    assert.match(out[0].text, /took longer than|did not respond/);
  } finally { globalThis.fetch = realFetch; m.close(); }
});

test('withProgress rethrows step errors and always reports done', async () => {
  const evs: any[] = [];
  const off = onEvent((e) => evs.push(e));
  await assert.rejects(() => withProgress('r1', 'Working', async () => { throw new Error('boom'); }), /boom/);
  off();
  assert.equal(evs.at(-1).state, 'done');
});
