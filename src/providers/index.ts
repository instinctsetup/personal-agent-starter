import type { Store } from '../config.js';
import type { ModelProvider } from './types.js';
import { OpenAiCompatibleProvider } from './openai.js';
import { MockProvider } from './mock.js';

export function createProvider(store: Store): ModelProvider {
  const s = store.getSettings().model;
  if (s.provider === 'openai-compatible') {
    const key = store.getSecrets().modelApiKey ?? '';
    if (!key) return new MockProvider(); // fail safe, UI labels it
    return new OpenAiCompatibleProvider(s.baseUrl, s.model, key);
  }
  return new MockProvider();
}

export type { ModelProvider, ChatMessage } from './types.js';
