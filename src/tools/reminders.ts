// Reminders: "remind me in 30 minutes to stretch", "remind me at 6pm to call home".
// Due reminders are delivered into the chat by a scheduler the server runs.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Reminder {
  id: string;
  text: string;
  dueAt: string; // ISO
  done: boolean;
}

/**
 * Parses a reminder phrase. Returns undefined when no time can be found -
 * the agent asks instead of guessing.
 */
export function parseReminder(input: string, now = new Date()): { text: string; dueAt: Date } | undefined {
  const s = input.trim();
  let m = s.match(/^(?:remind me )?in (\d+)\s*(second|minute|hour|day|week)s?\s+(?:to|that)\s+(.+)$/i)
    ?? s.match(/^(?:remind me )?in (\d+)\s*(second|minute|hour|day|week)s?\s*[:-]?\s*(.+)$/i);
  if (m) {
    const n = Number(m[1]);
    const mult = { second: 1e3, minute: 60e3, hour: 3600e3, day: 86400e3, week: 604800e3 }[m[2].toLowerCase() as 'minute'];
    return { text: m[3].trim(), dueAt: new Date(now.getTime() + n * mult) };
  }
  m = s.match(/^(?:remind me )?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(?:to|that)\s+(.+)$/i)
    ?? s.match(/^(?:remind me )?at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[:-]?\s*(.+)$/i);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    const ap = m[3]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return undefined;
    const due = new Date(now);
    due.setHours(h, min, 0, 0);
    if (due <= now) due.setDate(due.getDate() + 1);
    return { text: m[4].trim(), dueAt: due };
  }
  m = s.match(/^(?:remind me )?tomorrow(?: at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?\s+(?:to|that)\s+(.+)$/i);
  if (m) {
    let h = m[1] ? Number(m[1]) : 9;
    const min = Number(m[2] ?? 0);
    const ap = m[3]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    const due = new Date(now);
    due.setDate(due.getDate() + 1);
    due.setHours(h, min, 0, 0);
    return { text: m[4].trim(), dueAt: due };
  }
  return undefined;
}

export class ReminderStore {
  readonly path: string;
  private items: Reminder[];
  constructor(dir = join(process.cwd(), 'data')) {
    this.path = join(dir, 'reminders.json');
    this.items = existsSync(this.path) ? safeRead(this.path) : [];
  }
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.items, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }
  add(text: string, dueAt: Date): Reminder {
    const r = { id: randomUUID().slice(0, 8), text, dueAt: dueAt.toISOString(), done: false };
    this.items.push(r);
    this.save();
    return r;
  }
  pending(): Reminder[] {
    return this.items.filter((r) => !r.done).sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1));
  }
  due(now = new Date()): Reminder[] {
    return this.items.filter((r) => !r.done && new Date(r.dueAt) <= now);
  }
  markDone(id: string): void {
    const r = this.items.find((x) => x.id === id);
    if (r) {
      r.done = true;
      this.save();
    }
  }
}

function safeRead(path: string): Reminder[] {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
