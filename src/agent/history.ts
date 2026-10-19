// Append-only chat history shared by the web UI and the Telegram bot.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ChatEntry {
  n: number; // monotonically increasing line number
  ts: string;
  role: 'user' | 'assistant' | 'system';
  source: 'web' | 'telegram' | 'system';
  text: string;
  card?: { type: 'confirm'; id: string; kind: string; summary: string } | { type: 'questions'; id: string; questions: string[] };
}

export class History {
  readonly path: string;
  constructor(dir = join(process.cwd(), 'data')) {
    this.path = join(dir, 'chat.jsonl');
    if (!existsSync(this.path)) {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, '', { mode: 0o600 });
      chmodSync(this.path, 0o600);
    }
  }

  append(entry: Omit<ChatEntry, 'n' | 'ts'>): ChatEntry {
    const n = this.count() + 1;
    const full: ChatEntry = { n, ts: new Date().toISOString(), ...entry };
    appendFileSync(this.path, JSON.stringify(full) + '\n');
    return full;
  }

  private count(): number {
    try {
      const raw = readFileSync(this.path, 'utf8');
      return raw === '' ? 0 : raw.trimEnd().split('\n').length;
    } catch {
      return 0;
    }
  }

  /** Entries with n > after, oldest first. */
  after(after = 0, limit = 200): ChatEntry[] {
    try {
      const raw = readFileSync(this.path, 'utf8').trim();
      if (!raw) return [];
      const out: ChatEntry[] = [];
      for (const line of raw.split('\n')) {
        try {
          const e = JSON.parse(line) as ChatEntry;
          if (e.n > after) out.push(e);
        } catch { /* skip bad line */ }
        if (out.length >= limit) break;
      }
      return out;
    } catch {
      return [];
    }
  }

  recent(limit = 50): ChatEntry[] {
    const all = this.after(0, 100000);
    return all.slice(-limit);
  }
}
