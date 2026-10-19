export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelProvider {
  readonly name: string;
  /** True when this provider runs fully offline (used for honest UI labels). */
  readonly offline: boolean;
  chat(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number }): Promise<string>;
}
