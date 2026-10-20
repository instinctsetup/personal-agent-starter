import type { ChatMessage, ModelProvider } from './types.js';

/** Any OpenAI-compatible /chat/completions endpoint: OpenAI, OpenRouter, Ollama, LM Studio, etc. */
export class OpenAiCompatibleProvider implements ModelProvider {
  readonly name = 'openai-compatible';
  readonly offline = false;
  constructor(
    private baseUrl: string,
    private model: string,
    private apiKey: string,
    private signal?: AbortSignal,
  ) {}

  async chat(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number }): Promise<string> {
    const url = this.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    if (this.signal) {
      if (this.signal.aborted) controller.abort();
      else this.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: opts?.maxTokens ?? 800,
          temperature: opts?.temperature ?? 0.3,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Model endpoint returned ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('Model endpoint returned an empty completion');
      return content.trim();
    } finally {
      clearTimeout(timer);
    }
  }
}
