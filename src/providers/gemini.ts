import type { ChatMessage, ModelProvider } from './types.js';

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
  ) {}

  async chat(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number }): Promise<string> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(this.model)}:generateContent`;
    const system = messages.find((m) => m.role === 'system')?.content;
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    if (contents.length === 0) contents.push({ role: 'user', parts: [{ text: '' }] });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetch(url, {
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
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Gemini endpoint returned ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const content = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('')
        .trim();
      if (!content) throw new Error('Gemini endpoint returned an empty completion');
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}
