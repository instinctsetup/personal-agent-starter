// Telegram bot interface over plain long polling (no framework).
// Messages the user sends the bot are relayed into the same agent core the
// web chat uses, and replies go back to the bot chat.
import { log } from '../util/log.js';

export interface BotUpdate {
  chatId: number;
  fromName: string;
  text: string;
}

interface TgApiOptions {
  token: string;
  onMessage: (update: BotUpdate) => Promise<string>; // returns the reply text
  pollSeconds?: number;
}

export class TelegramBot {
  private offset = 0;
  private running = false;
  private abort: AbortController | null = null;
  constructor(private opts: TgApiOptions) {}

  private async api<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.opts.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.abort?.signal,
    });
    const data = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`);
    return data.result;
  }

  /** One API round-trip to validate the token. */
  async test(): Promise<{ ok: boolean; detail: string }> {
    try {
      const me = await this.api<{ username?: string }>('getMe', {});
      return { ok: true, detail: `Bot token works (@${me.username ?? 'unknown'}).` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    // Telegram message limit is 4096 chars.
    for (let i = 0; i < text.length; i += 4000) {
      await this.api('sendMessage', { chat_id: chatId, text: text.slice(i, i + 4000) });
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
  }

  private async loop(): Promise<void> {
    interface Update {
      update_id: number;
      message?: { chat: { id: number }; from?: { first_name?: string; username?: string }; text?: string };
    }
    while (this.running) {
      try {
        const updates = await this.api<Update[]>('getUpdates', {
          offset: this.offset,
          timeout: this.opts.pollSeconds ?? 25,
        });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          const msg = u.message;
          if (!msg?.text || !msg.chat?.id) continue;
          const update: BotUpdate = {
            chatId: msg.chat.id,
            fromName: msg.from?.first_name ?? msg.from?.username ?? 'there',
            text: msg.text,
          };
          try {
            const reply = await this.opts.onMessage(update);
            if (reply) await this.sendMessage(msg.chat.id, reply);
          } catch (err) {
            log.error('Telegram onMessage failed:', err instanceof Error ? err.message : err);
            await this.sendMessage(msg.chat.id, 'Something went wrong handling that. Check the app log.').catch(() => {});
          }
        }
      } catch (err) {
        if (!this.running) return;
        log.warn('Telegram poll error, retrying in 5s:', err instanceof Error ? err.message : err);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
}
