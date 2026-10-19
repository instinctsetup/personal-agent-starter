// Chat orchestration: deterministic intents first (always work offline),
// LLM for conversation and summaries. Every side effect passes through a
// confirmation card or a question card in the chat.
import type { Store } from '../config.js';
import { createProvider, type ModelProvider } from '../providers/index.js';
import { MailTools } from '../tools/mail.js';
import { TelegramChannels } from '../tools/telegramChannels.js';
import { LinkedInTools, LinkedInStopped, linkedinRiskNote } from '../tools/linkedin.js';
import { runJobApplication, logApplication, readApplicationLog } from '../tools/apply.js';
import { ProfileStore, PROFILE_LABELS, type Profile } from '../tools/profile.js';
import { parseIntent } from './intents.js';
import { NotesStore, looksSecret } from '../tools/notes.js';
import { ReminderStore, parseReminder } from '../tools/reminders.js';
import { FileTools } from '../tools/files.js';
import { PluginRegistry } from '../tools/plugins.js';
import { PendingManager } from './pending.js';
import { History, type ChatEntry } from './history.js';
import { log } from '../util/log.js';
import { join } from 'node:path';

export interface MessageSource {
  kind: 'web' | 'telegram';
  chatId?: number; // telegram chat to push follow-ups into
}

export type Notifier = (source: MessageSource, text: string) => void;

const HELP = `Here's what I can do:
- "check mail" / "unread mail" - latest inbox mail
- "mail search <words or address>" - search your inbox
- "summarize mail" - summarize your latest mail
- "send mail" - I'll ask who/what, then show you the email before sending
- paste a job link with "apply" - I fill the form from your saved profile, ask about gaps, and always confirm before submitting
- "applications" - your application log
- "telegram channels" - latest posts from your configured channels
- "telegram status" - bot/channel setup state
- "linkedin feed" - read the top of your feed (paced, capped)
- "linkedin apply <url>" - Easy Apply, confirm before submit
- "linkedin message <url>: <text>" / "linkedin invite <url>[: note]" - always confirmed first
- "linkedin login" - open the LinkedIn browser so you can log in once
- "remember ..." / "recall <topic>" / "notes" / "forget <id>" - long-term memory
- "remind me in 30 minutes to ..." / "remind me at 6pm to ..." / "reminders"
- "list files" / "read file X" / "write file X: ..." / "append file X: ..." - your workspace folder
- "plugins" - list loaded plugin commands
Anything else is just chat.`;

export class AgentCore {
  readonly pending = new PendingManager();
  readonly history: History;
  readonly profiles: ProfileStore;
  readonly notes: NotesStore;
  readonly reminders: ReminderStore;
  readonly files: FileTools;
  readonly plugins: PluginRegistry;
  private notifier: Notifier = () => {};
  private botState: 'off' | 'starting' | 'on' | 'error' = 'off';

  constructor(
    private store: Store,
    private mail: MailTools,
    private channels: TelegramChannels,
    private linkedin: LinkedInTools,
    dir = join(process.cwd(), 'data'),
  ) {
    this.history = new History(dir);
    this.profiles = new ProfileStore(dir);
    this.notes = new NotesStore(dir);
    this.reminders = new ReminderStore(dir);
    this.files = new FileTools(dir);
    this.plugins = new PluginRegistry(join(process.cwd(), 'plugins'));
    void this.plugins.load();
  }

  /** Delivers due reminders into the chat; called by the server's scheduler. */
  checkReminders(): number {
    const due = this.reminders.due();
    for (const r of due) {
      this.say({ kind: 'web' }, `Reminder: ${r.text}`);
      this.reminders.markDone(r.id);
    }
    return due.length;
  }

  setNotifier(n: Notifier): void {
    this.notifier = n;
  }

  setBotState(s: 'off' | 'starting' | 'on' | 'error'): void {
    this.botState = s;
  }

  private provider(): ModelProvider {
    return createProvider(this.store);
  }

  private say(source: MessageSource, text: string, card?: ChatEntry['card']): ChatEntry {
    const entry = this.history.append({ role: 'assistant', source: source.kind, text, card });
    this.notifier(source, text);
    return entry;
  }

  /** Main entry: one user message in, immediate reply text out. Long flows continue in the background. */
  async handle(text: string, source: MessageSource): Promise<string> {
    this.history.append({ role: 'user', source: source.kind, text });

    // Open question cards consume the next message as answers.
    const open = this.pending.currentQuestions();
    if (open) {
      const answers = parseAnswers(open.questions, text);
      this.pending.answerQuestions(open.id, answers);
      return this.say(source, 'Got it - continuing.').text;
    }

    const intent = parseIntent(text);
    switch (intent.name) {
      case 'help':
        return this.say(source, HELP).text;

      case 'mail.list':
        return this.guarded(source, async () => {
          const mails = await this.mail.listRecent(10, intent.unseenOnly);
          if (mails.length === 0) return intent.unseenOnly ? 'No unread mail.' : 'Inbox looks empty.';
          return mails.map((m) => `- ${m.date.slice(0, 16).replace('T', ' ')} | ${m.from} | ${m.subject}`).join('\n');
        });

      case 'mail.search':
        return this.guarded(source, async () => {
          const mails = await this.mail.search(intent.query, 10);
          if (mails.length === 0) return `No mail matching "${intent.query}".`;
          return `Found ${mails.length}:\n` + mails.map((m) => `- [uid ${m.uid}] ${m.date.slice(0, 10)} | ${m.from} | ${m.subject}`).join('\n');
        });

      case 'mail.summarize':
        return this.guarded(source, async () => {
          const mails = await this.mail.listRecent(intent.count, false);
          if (mails.length === 0) return 'Inbox looks empty.';
          const provider = this.provider();
          const parts: string[] = [];
          for (const m of mails) {
            try {
              const full = await this.mail.read(m.uid);
              const sum = await provider.chat([
                { role: 'system', content: 'Summarize this email in one or two short sentences.' },
                { role: 'user', content: `From: ${full.from}\nSubject: ${full.subject}\n\n${full.text.slice(0, 4000)}` },
              ]);
              parts.push(`- ${full.from} | ${full.subject}\n  ${sum}`);
            } catch (err) {
              parts.push(`- ${m.from} | ${m.subject} (could not read: ${err instanceof Error ? err.message : 'error'})`);
            }
          }
          return parts.join('\n');
        });

      case 'mail.send': {
        // Guided collection via one question card, then a confirm card.
        const card = this.pending.askQuestions(['To (email address)', 'Subject', 'Body']);
        this.say(source, 'Sure - answer these three (one per line, "Label: value" works):', {
          type: 'questions',
          id: card.card.id,
          questions: card.card.questions,
        });
        void (async () => {
          const answers = await card.wait;
          if (!answers) return this.say(source, 'Timed out waiting for the email details - start again with "send mail".');
          const to = answers['To (email address)'] ?? '';
          const subject = answers.Subject ?? '';
          const body = answers.Body ?? '';
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return this.say(source, `"${to}" doesn't look like an email address. Start again with "send mail".`);
          const conf = this.pending.askConfirmation('mail-send', `Send this email?\n\nTo: ${to}\nSubject: ${subject}\n\n${body}`);
          this.say(source, conf.action.summary, { type: 'confirm', id: conf.action.id, kind: 'mail-send', summary: conf.action.summary });
          const ok = await conf.wait;
          if (!ok) return this.say(source, 'Okay, not sending that email.');
          try {
            const r = await this.mail.send(to, subject, body);
            this.say(source, `Sent. Message id: ${r.messageId || '(accepted)'}`);
          } catch (err) {
            this.say(source, `Send failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
        return 'Collecting the email details...';
      }

      case 'apply': {
        this.say(source, `On it - opening ${intent.url} in a browser and mapping the form to your saved profile. I'll ask if anything's missing and confirm before submitting.`);
        void this.runApply(intent.url, source);
        return 'Started the application flow.';
      }

      case 'applications': {
        const rows = readApplicationLog(join(this.store.dir), 20);
        if (rows.length === 0) return this.say(source, 'No applications logged yet. Paste a job link with "apply" to start.').text;
        return this.say(
          source,
          'Application log (latest first):\n' +
            rows.map((r) => `- ${String(r.ts ?? '').slice(0, 16).replace('T', ' ')} | ${String(r.status)} | ${String(r.url)}`).join('\n'),
        ).text;
      }

      case 'telegram.channels':
        return this.guarded(source, async () => {
          const posts = await this.channels.readChannels(5);
          if (posts.length === 0) return 'No posts found in your configured channels.';
          return posts.map((p) => `- [${p.channel}] ${p.date.slice(0, 16).replace('T', ' ')}: ${p.text.slice(0, 300)}${p.link ? ` (${p.link})` : ''}`).join('\n');
        });

      case 'telegram.status': {
        const s = this.store.getSettings();
        const lines = [
          `Telegram bot: ${this.botState}${s.telegram.botEnabled ? '' : ' (disabled in Settings)'}`,
          `Channel reading: ${this.store.hasTelegramUser() ? 'logged in' : 'not set up (needs api_id/api_hash + one-time login)'}`,
          `Configured channels: ${s.telegram.channels.length ? s.telegram.channels.join(', ') : 'none'}`,
        ];
        return this.say(source, lines.join('\n')).text;
      }

      case 'linkedin.feed':
        return this.guarded(source, async () => {
          const posts = await this.linkedin.readFeed(5);
          if (posts.length === 0) return 'Feed came back empty.';
          return 'Top of your LinkedIn feed:\n' + posts.map((p) => `- ${p.author}: ${p.text.slice(0, 280)}`).join('\n');
        });

      case 'linkedin.apply': {
        this.say(source, 'Starting Easy Apply in a visible browser window - watch it if you like. I will confirm before the final submit.');
        void (async () => {
          try {
            const r = await this.linkedin.easyApply(intent.url, this.profiles.get(), {
              askFacts: (qs) => this.askInChat(source, qs),
              confirmSubmit: (sum) => this.confirmInChat(source, 'linkedin-submit', sum),
            });
            logApplication(this.store.dir, { url: intent.url, status: `linkedin-${r.status}`, via: 'easy-apply' });
            this.say(source, `LinkedIn Easy Apply: ${r.status}. ${r.detail}`);
          } catch (err) {
            this.say(source, stoppedMessage(err));
          }
        })();
        return 'Started LinkedIn Easy Apply.';
      }

      case 'linkedin.message': {
        if (!intent.text) return this.say(source, 'Add the message after a colon, e.g. linkedin message <url>: Hi, ...').text;
        void (async () => {
          try {
            const r = await this.linkedin.sendMessage(intent.url, intent.text, (sum) => this.confirmInChat(source, 'linkedin-submit', sum));
            this.say(source, `LinkedIn message: ${r.status}. ${r.detail}`);
          } catch (err) {
            this.say(source, stoppedMessage(err));
          }
        })();
        return this.say(source, 'Preparing the LinkedIn message - confirm when the card appears.').text;
      }

      case 'linkedin.invite': {
        void (async () => {
          try {
            const r = await this.linkedin.sendInvite(intent.url, intent.note, (sum) => this.confirmInChat(source, 'linkedin-submit', sum));
            this.say(source, `LinkedIn invite: ${r.status}. ${r.detail}`);
          } catch (err) {
            this.say(source, stoppedMessage(err));
          }
        })();
        return this.say(source, 'Preparing the invite - confirm when the card appears.').text;
      }

      case 'linkedin.login':
        return this.guarded(source, () => this.linkedin.openForManualLogin());

      case 'linkedin.status': {
        const gate = this.linkedin.isEnabled();
        const logged = gate.ok ? await this.linkedin.isLoggedIn().catch(() => false) : false;
        const s = this.store.getSettings().linkedin;
        const lines = [
          `LinkedIn assist: ${s.enabled ? 'on' : 'off'}${s.riskAccepted ? '' : ' (risk note not accepted)'}`,
          gate.ok ? `Session: ${logged ? 'logged in' : 'not logged in - say "linkedin login"'}` : gate.reason!,
          this.linkedin.statusLine(),
        ];
        return this.say(source, lines.join('\n')).text;
      }

      case 'remember': {
        if (looksSecret(intent.text)) {
          return this.say(source, "That looks like a secret, so I won't store it in notes - notes are plain text on disk. Keep secrets in a password manager.").text;
        }
        const n = this.notes.add(intent.text);
        return this.say(source, `Remembered (note ${n.id}).`).text;
      }

      case 'recall': {
        const hits = this.notes.search(intent.query);
        if (hits.length === 0) return this.say(source, `Nothing in my notes about "${intent.query}".`).text;
        return this.say(source, hits.map((n) => `- [${n.id}] ${n.text}`).join('\n')).text;
      }

      case 'notes': {
        const all = this.notes.all();
        if (all.length === 0) return this.say(source, 'No notes yet. Say "remember ..." to add one.').text;
        return this.say(source, all.map((n) => `- [${n.id}] ${n.text}`).join('\n')).text;
      }

      case 'forget': {
        const removed = this.notes.remove(intent.id);
        return this.say(source, removed ? `Forgot note ${removed.id}.` : `No note with id ${intent.id}.`).text;
      }

      case 'remind': {
        const parsed = parseReminder(intent.raw);
        if (!parsed) return this.say(source, 'I could not find a time in that. Try "remind me in 30 minutes to ..." or "remind me at 6pm to ...".').text;
        const r = this.reminders.add(parsed.text, parsed.dueAt);
        return this.say(source, `Reminder set for ${fmtLocal(r.dueAt)}: ${r.text}`).text;
      }

      case 'reminders': {
        const pending = this.reminders.pending();
        if (pending.length === 0) return this.say(source, 'No pending reminders.').text;
        return this.say(source, pending.map((r) => `- ${fmtLocal(r.dueAt)}: ${r.text}`).join('\n')).text;
      }

      case 'files.list': {
        const list = this.files.list();
        if (list.length === 0) return this.say(source, 'Workspace is empty. Try "write file hello.txt: hi".').text;
        return this.say(source, list.map((f) => `- ${f.name} (${f.size} bytes)`).join('\n')).text;
      }

      case 'files.read':
        return this.guarded(source, async () => this.files.read(intent.name2));

      case 'files.write':
        return this.guarded(source, async () => `Wrote ${this.files.write(intent.name2, intent.content)}.`);

      case 'files.append':
        return this.guarded(source, async () => `Appended to ${this.files.append(intent.name2, intent.content)}.`);

      case 'plugins': {
        const list = this.plugins.list();
        if (list.length === 0) return this.say(source, 'No plugins loaded. Drop an .mjs file into the plugins/ folder - see plugins/hello.example.mjs.').text;
        return this.say(source, list.map((p) => `- ${p.name}: ${p.help.join('; ')}`).join('\n')).text;
      }

      case 'chat':
      default: {
        const pluginReply = await this.plugins.run(text, this.store).catch(() => undefined);
        if (pluginReply !== undefined) return this.say(source, pluginReply).text;
        const provider = this.provider();
        const recent = this.history.recent(20).map((e) => ({ role: e.role, content: e.text }));
        try {
          const reply = await provider.chat([
            { role: 'system', content: 'You are a concise personal assistant in a chat app. Reply briefly and plainly. If the user seems to want mail, Telegram, job applications or LinkedIn, mention the matching command from this list: check mail, send mail, apply <link>, telegram channels, linkedin feed, linkedin apply/message/invite.' },
            ...recent,
          ]);
          return this.say(source, reply).text;
        } catch (err) {
          return this.say(source, `The model provider failed (${err instanceof Error ? err.message : String(err)}). Try a command like "check mail", or fix the provider in Settings.`).text;
        }
      }
    }
  }

  private async guarded(source: MessageSource, fn: () => Promise<string>): Promise<string> {
    try {
      const out = await fn();
      return this.say(source, out).text;
    } catch (err) {
      return this.say(source, err instanceof Error ? err.message : String(err)).text;
    }
  }

  private askInChat(source: MessageSource, questions: string[]): Promise<Record<string, string>> {
    const card = this.pending.askQuestions(questions);
    this.say(source, `I need these facts (answer one per line, "Label: value"):`, { type: 'questions', id: card.card.id, questions });
    return card.wait.then((a) => a ?? {});
  }

  private confirmInChat(source: MessageSource, kind: 'mail-send' | 'apply-submit' | 'linkedin-submit', summary: string): Promise<boolean> {
    const conf = this.pending.askConfirmation(kind, summary);
    this.say(source, summary, { type: 'confirm', id: conf.action.id, kind, summary });
    return conf.wait;
  }

  private async runApply(url: string, source: MessageSource): Promise<void> {
    const dataDir = this.store.dir;
    try {
      const profile: Profile = this.profiles.get();
      if (!profile.firstName || !profile.email || !profile.resumePath) {
        const labels = (['firstName', 'lastName', 'email', 'phone', 'resumePath'] as const).filter((k) => !profile[k]);
        const answers = await this.askInChat(source, labels.map((k) => PROFILE_LABELS[k]));
        if (Object.keys(answers).length === 0) {
          this.say(source, 'Stopped - I need at least your name, email and resume path before applying anywhere.');
          return;
        }
        const patch: Partial<Profile> = {};
        for (const k of labels) {
          const v = answers[PROFILE_LABELS[k]];
          if (v) (patch as Record<string, string>)[k] = v;
        }
        this.profiles.save(patch);
      }
      const result = await runJobApplication(
        { url, profile: this.profiles.get(), dataDir },
        {
          askFacts: (qs) => this.askInChat(source, qs),
          confirmSubmit: (sum) => this.confirmInChat(source, 'apply-submit', sum),
        },
      );
      const tail = result.error ? ` (${result.error})` : '';
      this.say(source, `Application ${result.status}.${tail}${result.screenshot ? ` Screenshot saved: ${result.screenshot}` : ''}`);
    } catch (err) {
      log.error('apply flow crashed:', err instanceof Error ? err.message : err);
      logApplication(dataDir, { url, status: 'failed', error: err instanceof Error ? err.message : String(err) });
      this.say(source, `Application failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Parses "Label: value" lines; falls back to positional lines for unlabeled answers. */
export function parseAnswers(questions: string[], text: string): Record<string, string> {
  const answers: Record<string, string> = {};
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const remaining = new Set(questions);
  for (const line of lines) {
    const m = line.match(/^([^:]{1,60}):\s*(.+)$/);
    if (m) {
      const label = questions.find((q) => q.toLowerCase() === m[1].trim().toLowerCase() || q.toLowerCase().includes(m[1].trim().toLowerCase()));
      if (label) {
        answers[label] = m[2].trim();
        remaining.delete(label);
        continue;
      }
    }
    const next = [...remaining][0];
    if (next) {
      answers[next] = line;
      remaining.delete(next);
    }
  }
  return answers;
}

export function fmtLocal(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
}

function stoppedMessage(err: unknown): string {
  if (err instanceof LinkedInStopped) return `Stopped: ${err.message}`;
  return `LinkedIn action failed: ${err instanceof Error ? err.message : String(err)}`;
}

export { linkedinRiskNote };
