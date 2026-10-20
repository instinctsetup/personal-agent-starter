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

/** Which stage of talking to Google a request belongs to. */
export type GeminiStep = 'model-check' | 'generate-ping' | 'chat';

/** One line of diagnostics about a request attempt, for logs and `npm run check:gemini`. */
export interface GeminiStepEvent {
  step: GeminiStep;
  attempt: number;
  state: 'start' | 'ok' | 'retry' | 'error';
  elapsedMs: number;
  detail?: string;
}

/**
 * The model-metadata GET is cheap and answers in well under a second on a
 * healthy connection. Generation is different: thinking models can spend a
 * long time reasoning before the first token, especially on the first call
 * after a cold start, so chat/generate requests get a much longer budget.
 */
const MODEL_CHECK_TIMEOUT_MS = 30_000;
const GENERATE_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 2; // first try + one retry, but only on timeout/network failure

/** Overridable for tests. */
export interface GeminiRequestOptions {
  timeoutMs?: number;
  attempts?: number;
  onStep?: (event: GeminiStepEvent) => void;
  /** Overrides the stage label used in logs and timeout messages. */
  step?: GeminiStep;
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

function describeStep(step: GeminiStep): string {
  switch (step) {
    case 'model-check':
      return 'the model check (GET model metadata)';
    case 'generate-ping':
      return 'the generate ping (a tiny test completion)';
    default:
      return 'the chat request';
  }
}

/**
 * fetch with a timeout and one retry, but only when the request never
 * got an answer (timeout or network failure). HTTP errors are not retried.
 * Aborted fetches surface as a DOMException whose message is the cryptic
 * "This operation was aborted" - translate that into actionable text that
 * names the step, so a slow thinking model is not mistaken for a dead network.
 * Every attempt is reported through opts.onStep for diagnostics.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: (GeminiRequestOptions & { step?: GeminiStep }) | undefined,
  defaultTimeoutMs: number,
): Promise<Response> {
  const step: GeminiStep = opts?.step ?? 'chat';
  const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs;
  const maxAttempts = opts?.attempts ?? MAX_ATTEMPTS;
  const report = (event: GeminiStepEvent) => {
    try {
      opts?.onStep?.(event);
    } catch {
      /* a broken logger must never break a request */
    }
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    report({ step, attempt, state: 'start', elapsedMs: 0 });
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      report({ step, attempt, state: 'ok', elapsedMs: Date.now() - started, detail: `HTTP ${res.status}` });
      return res;
    } catch (err: any) {
      const elapsedMs = Date.now() - started;
      const isTimeout = err?.name === 'AbortError' || err?.name === 'TimeoutError';
      const reason = err?.cause?.message || err?.message || String(err);
      if (attempt < maxAttempts) {
        report({ step, attempt, state: 'retry', elapsedMs, detail: isTimeout ? `timeout after ${timeoutMs}ms` : reason });
        continue; // retry once on timeout/network
      }
      report({ step, attempt, state: 'error', elapsedMs, detail: isTimeout ? `timeout after ${timeoutMs}ms` : reason });
      if (isTimeout) {
        throw new GeminiError(
          `Gemini did not respond within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`} during ${describeStep(step)} (tried ${maxAttempts} times). The request to Google timed out` +
            (step === 'model-check'
              ? ' - check your internet connection, firewall, antivirus web filter or VPN, and make sure generativelanguage.googleapis.com is reachable from your network.'
              : ' - if simpler requests to Google work, this is usually a thinking model still reasoning on a cold first call, so try again or run `npm run check:gemini` to watch each step; otherwise check your internet connection, firewall, antivirus web filter or VPN.'),
          'timeout',
        );
      }
      throw new GeminiError(
        `Could not reach Google during ${describeStep(step)} (network error: ${reason}). Check your internet connection, firewall or VPN.`,
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
    }, { step: 'chat' as GeminiStep, ...this.reqOpts }, GENERATE_TIMEOUT_MS);
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

/** Default diagnostics sink: one line per attempt on the daemon console. Never includes the key. */
function logStepToConsole(event: GeminiStepEvent): void {
  const timing = event.state === 'start' ? '' : ` in ${event.elapsedMs}ms`;
  const detail = event.detail ? ` (${event.detail})` : '';
  console.log(`[gemini] ${event.step} attempt ${event.attempt}: ${event.state}${timing}${detail}`);
}

/**
 * Validate a key + model cheaply before trusting them: GET /models/{model}
 * answers fast and separates a bad key (400) from an unknown model (404)
 * without spending generation quota, then one tiny generateContent ping
 * proves generation actually works. Throws a classified GeminiError.
 * Each step is timed and logged to the daemon console (pass reqOpts.onStep
 * to redirect the lines, e.g. the check:gemini script).
 */
export async function validateGeminiConnection(
  model: string,
  apiKey: string,
  baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
  reqOpts?: GeminiRequestOptions,
): Promise<void> {
  const base = baseUrl.replace(/\/+$/, '');
  const opts: GeminiRequestOptions = { onStep: logStepToConsole, ...reqOpts };
  const res = await fetchWithRetry(`${base}/models/${encodeURIComponent(model)}`, {
    headers: { 'x-goog-api-key': apiKey },
  }, { ...opts, step: 'model-check' }, MODEL_CHECK_TIMEOUT_MS);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw classifyHttpError(res.status, body, model);
  }
  await res.text().catch(() => ''); // drain the body
  // thinking models can burn a small budget on reasoning, so give the ping room;
  // the ping itself gets a longer timeout than the metadata check (cold-start reasoning)
  const pingOpts: GeminiRequestOptions = {
    ...opts,
    timeoutMs: reqOpts?.timeoutMs ?? GENERATE_TIMEOUT_MS,
    step: 'generate-ping',
  };
  await new GeminiProvider(model, apiKey, base, pingOpts).chat([{ role: 'user', content: 'ping' }], { maxTokens: 1024 });
}

/** Exported for the check:gemini script and docs. */
export const GEMINI_TIMEOUTS = {
  modelCheckMs: MODEL_CHECK_TIMEOUT_MS,
  generateMs: GENERATE_TIMEOUT_MS,
} as const;
