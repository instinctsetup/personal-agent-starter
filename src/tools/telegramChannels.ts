// Reads Telegram channels the user configured, through GramJS (user client).
// Requires the user's own api_id/api_hash (my.telegram.org) and a one-time
// interactive login; the resulting session string is stored in secrets.json.
// NOTE: live-verified only with the user's own credentials - the app labels
// this feature accordingly until the first successful sync.
import { log } from '../util/log.js';
import type { Store } from '../config.js';

export interface ChannelPost {
  channel: string;
  date: string;
  text: string;
  link?: string;
}

export class TelegramChannels {
  constructor(private store: Store) {}

  private async client() {
    const s = this.store.getSettings().telegram;
    const session = this.store.getSecrets().telegramSession ?? '';
    if (!s.apiId || !s.apiHash || !session) {
      throw new Error('Telegram channel reading is not set up. Add api_id, api_hash and complete the one-time login in Settings.');
    }
    const { TelegramClient } = await import('telegram');
    const { StringSession } = await import('telegram/sessions/index.js');
    const client = new TelegramClient(new StringSession(session), Number(s.apiId), s.apiHash, {
      connectionRetries: 3,
    });
    await client.connect();
    return client;
  }

  /** One-time interactive login helper. Prompts run in the terminal. */
  static async interactiveLogin(apiId: string, apiHash: string, prompt: (q: string) => Promise<string>): Promise<string> {
    const { TelegramClient } = await import('telegram');
    const { StringSession } = await import('telegram/sessions/index.js');
    const client = new TelegramClient(new StringSession(''), Number(apiId), apiHash, { connectionRetries: 3 });
    await client.start({
      phoneNumber: () => prompt('Phone number (international format): '),
      password: () => prompt('Two-factor password (if set): '),
      phoneCode: () => prompt('Login code from Telegram: '),
      onError: (err: unknown) => log.warn('Telegram login error:', err instanceof Error ? err.message : err),
    });
    const session = (client.session as unknown as { save(): string }).save();
    await client.disconnect();
    return session;
  }

  async testConnection(): Promise<{ ok: boolean; detail: string }> {
    try {
      const client = await this.client();
      try {
        const me = await client.getMe();
        return { ok: true, detail: `Logged in as ${String(me?.['username'] ?? me?.['firstName'] ?? 'user')}.` };
      } finally {
        await client.disconnect();
      }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Latest posts from each configured channel. Read-only. */
  async readChannels(perChannel = 5): Promise<ChannelPost[]> {
    const channels = this.store.getSettings().telegram.channels;
    if (channels.length === 0) throw new Error('No Telegram channels configured yet. Add some in Settings.');
    const n = Math.max(1, Math.min(20, Math.floor(perChannel) || 5));
    const client = await this.client();
    try {
      const out: ChannelPost[] = [];
      for (const raw of channels) {
        const name = raw.replace(/^https?:\/\/t\.me\//, '').replace(/^@/, '').replace(/\/+$/, '');
        try {
          const entity = await client.getEntity(name);
          const messages = await client.getMessages(entity, { limit: n });
          for (const m of messages) {
            const text = (m.message ?? '').trim();
            if (!text) continue;
            out.push({
              channel: name,
              date: m.date ? new Date(m.date * 1000).toISOString() : '',
              text: text.slice(0, 2000),
              link: m.id ? `https://t.me/${name}/${m.id}` : undefined,
            });
          }
        } catch (err) {
          log.warn(`Failed reading channel ${name}:`, err instanceof Error ? err.message : err);
          out.push({ channel: name, date: '', text: `(could not read this channel: ${err instanceof Error ? err.message : 'error'})` });
        }
      }
      return out.sort((a, b) => (a.date < b.date ? 1 : -1));
    } finally {
      await client.disconnect();
    }
  }
}
