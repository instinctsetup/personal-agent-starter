// Gmail over IMAP (read/search) and SMTP (send) using an app password.
// No live mail ever happens without the user's stored credentials, and
// sending is always gated behind a confirmation in the chat UI.
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Store } from '../config.js';

export interface MailSummary {
  uid: number;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

export interface MailFull extends MailSummary {
  to: string;
  text: string;
}

function mailAuth(store: Store) {
  const s = store.getSettings().mail;
  const pass = store.getSecrets().mailAppPassword;
  if (!s.user || !pass) throw new Error('Mail is not connected yet. Finish the mail step in Settings (Gmail address + app password).');
  return { s, pass };
}

export class MailTools {
  constructor(private store: Store) {}

  private async withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const { s, pass } = mailAuth(this.store);
    const client = new ImapFlow({
      host: s.imapHost,
      port: s.imapPort,
      secure: true,
      auth: { user: s.user, pass },
      logger: false,
      socketTimeout: 30_000,
    });
    client.on('error', () => {}); // errors surface through awaited calls
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => {});
    }
  }

  /** Verify credentials without changing anything. */
  async testConnection(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.withImap(async (client) => {
        await client.mailboxOpen('INBOX');
      });
      return { ok: true, detail: 'IMAP login worked.' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async listRecent(limit = 10, unseenOnly = false): Promise<MailSummary[]> {
    const n = Math.max(1, Math.min(50, Math.floor(limit) || 10));
    return this.withImap(async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const criteria = unseenOnly ? { seen: false } : { all: true };
        const ids = await client.search(criteria, { uid: true });
        if (!ids || ids.length === 0) return [];
        const out: MailSummary[] = [];
        for await (const m of client.fetch(ids.slice(-n), { envelope: true, bodyParts: ['text'], uid: true }, { uid: true })) {
          const env = m.envelope;
          out.push({
            uid: m.uid,
            from: env?.from?.map((a) => a.address ?? a.name ?? '').join(', ') ?? '',
            subject: env?.subject ?? '(no subject)',
            date: env?.date?.toISOString?.() ?? '',
            snippet: '',
          });
        }
        return out.reverse();
      } finally {
        lock.release();
      }
    });
  }

  async search(query: string, limit = 10): Promise<MailSummary[]> {
    const n = Math.max(1, Math.min(50, Math.floor(limit) || 10));
    return this.withImap(async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        let ids: number[] | false;
        if (query.includes('@')) ids = await client.search({ from: query }, { uid: true });
        else ids = await client.search({ or: [{ subject: query }, { from: query }, { body: query }] }, { uid: true });
        if (!ids || ids.length === 0) return [];
        const out: MailSummary[] = [];
        for await (const m of client.fetch(ids.slice(-n), { envelope: true, uid: true }, { uid: true })) {
          const env = m.envelope;
          out.push({
            uid: m.uid,
            from: env?.from?.map((a) => a.address ?? a.name ?? '').join(', ') ?? '',
            subject: env?.subject ?? '(no subject)',
            date: env?.date?.toISOString?.() ?? '',
            snippet: '',
          });
        }
        return out.reverse();
      } finally {
        lock.release();
      }
    });
  }

  async read(uid: number): Promise<MailFull> {
    return this.withImap(async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
        if (!msg || !msg.source) throw new Error(`No message with UID ${uid}`);
        const parsed = await simpleParser(msg.source);
        const env = msg.envelope;
        return {
          uid,
          from: env?.from?.map((a) => a.address ?? a.name ?? '').join(', ') ?? '',
          to: env?.to?.map((a) => a.address ?? '').join(', ') ?? '',
          subject: env?.subject ?? parsed.subject ?? '(no subject)',
          date: env?.date?.toISOString?.() ?? '',
          snippet: '',
          text: (parsed.text ?? '').slice(0, 20_000),
        };
      } finally {
        lock.release();
      }
    });
  }

  /** Actual send - only called after an explicit user confirmation. */
  async send(to: string, subject: string, text: string): Promise<{ messageId: string }> {
    const { s, pass } = mailAuth(this.store);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error(`"${to}" is not a valid recipient address`);
    const transport = nodemailer.createTransport({
      host: s.smtpHost,
      port: s.smtpPort,
      secure: s.smtpPort === 465,
      requireTLS: s.smtpPort !== 465,
      auth: { user: s.user, pass },
      connectionTimeout: 15_000,
      logger: false,
      debug: false,
    });
    try {
      const from = s.fromName ? `"${s.fromName.replace(/"/g, '')}" <${s.user}>` : s.user;
      const result = await transport.sendMail({ from, to, subject, text, disableFileAccess: true, disableUrlAccess: true });
      return { messageId: String(result.messageId ?? '') };
    } finally {
      transport.close();
    }
  }
}
