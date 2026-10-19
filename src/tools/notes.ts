// Long-term memory: plain notes the user asks the agent to remember.
// Stored in data/notes.json (mode 600). Never store secrets here - the
// agent says so when asked to remember something that looks like a secret.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Note {
  id: string;
  text: string;
  createdAt: string;
}

const SECRETISH = /password|passphrase|api.?key|token|secret|cvv|otp|pin\b/i;

export function looksSecret(text: string): boolean {
  return SECRETISH.test(text);
}

export class NotesStore {
  readonly path: string;
  private notes: Note[];
  constructor(dir = join(process.cwd(), 'data')) {
    this.path = join(dir, 'notes.json');
    this.notes = existsSync(this.path) ? safeRead(this.path) : [];
  }
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.notes, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }
  add(text: string): Note {
    const note = { id: randomUUID().slice(0, 8), text: text.trim(), createdAt: new Date().toISOString() };
    this.notes.push(note);
    this.save();
    return note;
  }
  search(query: string): Note[] {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    return this.notes.filter((n) => {
      const t = n.text.toLowerCase();
      return words.some((w) => t.includes(w));
    });
  }
  remove(idPrefix: string): Note | undefined {
    const i = this.notes.findIndex((n) => n.id.startsWith(idPrefix));
    if (i < 0) return undefined;
    const [removed] = this.notes.splice(i, 1);
    this.save();
    return removed;
  }
  all(): Note[] {
    return [...this.notes];
  }
}

function safeRead(path: string): Note[] {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
