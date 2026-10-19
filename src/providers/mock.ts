import type { ChatMessage, ModelProvider } from './types.js';

/**
 * Deterministic offline provider for tests and demos. No network, no key.
 * It understands a tiny script format so tests can assert behavior, and
 * otherwise produces a simple extractive "summary" style reply.
 */
export class MockProvider implements ModelProvider {
  readonly name = 'mock';
  readonly offline = true;

  async chat(messages: ChatMessage[]): Promise<string> {
    const last = [...messages].reverse().find((m) => m.role === 'user');
    const text = last?.content ?? '';
    const system = messages.find((m) => m.role === 'system')?.content ?? '';

    if (/^summari[sz]e/i.test(system) || /^summari[sz]e/i.test(text)) {
      const body = text.replace(/^summari[sz]e[:\s]*/i, '').trim();
      const first = body.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').slice(0, 280);
      return `Summary: ${first || '(empty input)'}`;
    }
    return `Mock reply: I understood "${text.slice(0, 120)}". Connect a model provider in Settings for real answers.`;
  }
}
