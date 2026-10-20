import type { ChatMessage, ModelProvider } from './types.js';

/** Classified Gemini failure so callers can react (e.g. fall back on model_not_found). */
export type GeminiErrorCode =
  | 'timeout'
  | 'network'
  | 'key_invalid'
  | 'model_not_found'
  | 'permission'
  | 'rate_limited'
  | 'http'
  | 'empty';

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly code: GeminiErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 2; // first try + one retry, but only on timeout/network failure

/** Overridable for tests. */
export interface GeminiRequestOptions {
  timeoutMs?: number;
  attempts?: number;
}

/** Pull the useful message out of a Google API error body. */
function extractDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed?.error?.message === 'string') return parsed.error.message;
  } catch {
    /* not JSON */
  }
  return body.trim().slice(0, 200);
}

function classifyHttpError(status: number, body: string, model: string): GeminiError {
  const detail = extractDetail(body);
  if (status === 400 && /api key not valid/i.test(detail)) {
    return new GeminiError(
      'Gemini API key is not valid (400). Create a free key at aistudio.google.com > Get API key and paste it exactly.',
      'key_invalid',
      status,
    );
  }
  if (status === 400) {
    return new GeminiError(`Google rejected the request (400): ${detail}`, 'http', status);
  }
  if (status === 403) {
    return new GeminiError(
      `Permission denied (403): ${detail} - the key may be restricted, or the Generative Language API may not be enabled on that Google Cloud project.`,
      'permission',
      status,
    );
  }
  if (status === 404) {
    return new GeminiError(
      `Model "${model}" was not found (404). Check the exact model id at ai.google.dev/gemini-api/docs/models - free-tier options include gemini-3.8-flash and gemini-2.5-flash.`,
      'model_not_found',
      status,
    );
  }
  if (status === 429) {
    return new GeminiError(
      'Gemini free-tier rate limit reached (429). Wait a minute and try again; your usage and limits are at aistudio.google.com/rate-limit.',
      'rate_limited',
      status,
    );
  }
  return new GeminiError(`Gemini endpoint returned ${status}: ${detail}`, 'http', status);
}

/**
 * fetch with a 30s timeout and one retry, but only when the request never
 * got an answer (timeout or network failure). HTTP errors are not retried.
 * Aborted fetches surface as a DOMException whose message is the cryptic
 * "This operation was aborted" - translate that into actionable text.
 */
async function fetchWithRetry(url: string, init: RequestInit, opts?: GeminiRequestOptions): Promise<Response> {
  const timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxAttempts = opts?.attempts ?? MAX_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err: any) {
      const isTimeout = err?.name === 'AbortError' || err?.name === 'TimeoutError';
      if (attempt < maxAttempts) continue; // retry once on timeout/network
      const reason = err?.cause?.message || err?.message || String(err);
      if (isTimeout) {
        throw new GeminiError(
          `Gemini did not respond within ${Math.round(timeoutMs / 1000)}s (tried ${maxAttempts} times). The request to Google timed out - check your internet connection, firewall, antivirus web filter or VPN, and make sure generativelanguage.googleapis.com is reachable from your network.`,
          'timeout',
        );
      }
      throw new GeminiError(
        `Could not reach Google (network error: ${reason}). Check your internet connection, firewall or VPN.`,
        'network',
      );
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('unreachable');
}

/**
 * Google Gemini (AI Studio) provider via the native generateContent API.
 * Free API keys come from https://aistudio.google.com - no billing needed
 * for the free tier. A consumer Gemini app subscription is NOT required
 * and is not the same thing as an API key.
 */
export class GeminiProvider implements ModelProvider {
  readonly name = 'gemini';
  readonly offline = false;
  constructor(
    private model: string,
    private apiKey: string,
    private baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
    private reqOpts?: GeminiRequestOptions,
  ) {}

  async chat(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number }): Promise<string> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(this.model)}:generateContent`;
    const system = messages.find((m) => m.role === 'system')?.content;
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    if (contents.length === 0) contents.push({ role: 'user', parts: [{ text: '' }] });
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents,
        generationConfig: {
          // thinking models can spend small budgets on reasoning alone, so floor it
          maxOutputTokens: Math.max(opts?.maxTokens ?? 800, 128),
          temperature: opts?.temperature ?? 0.3,
        },
      }),
    }, this.reqOpts);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw classifyHttpError(res.status, body, this.model);
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    };
    const content = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (!content) {
      const finish = data.candidates?.[0]?.finishReason;
      throw new GeminiError(
        `Gemini returned an empty completion${finish ? ` (finish reason: ${finish})` : ''}. A thinking model can spend the whole token budget on reasoning - try again or raise the token limit.`,
        'empty',
      );
    }
    return content;
  }
}

/**
 * Validate a key + model cheaply before trusting them: GET /models/{model}
 * answers fast and separates a bad key (400) from an unknown model (404)
 * without spending generation quota, then one tiny generateContent ping
 * proves generation actually works. Throws a classified GeminiError.
 */
export async function validateGeminiConnection(
  model: string,
  apiKey: string,
  baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
  reqOpts?: GeminiRequestOptions,
): Promise<void> {
  const base = baseUrl.replace(/\/+$/, '');
  const res = await fetchWithRetry(`${base}/models/${encodeURIComponent(model)}`, {
    headers: { 'x-goog-api-key': apiKey },
  }, reqOpts);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw classifyHttpError(res.status, body, model);
  }
  await res.text().catch(() => ''); // drain the body
  // thinking models can burn a small budget on reasoning, so give the ping room
  await new GeminiProvider(model, apiKey, base, reqOpts).chat([{ role: 'user', content: 'ping' }], { maxTokens: 1024 });
}
