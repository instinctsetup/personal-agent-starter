/** Inbox read (IMAP) + send (SMTP) using settings + vault-stored app password. Sending is approval-gated in agent2. */
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { getSetting } from "./db.js";
import { getCredential, listCredentials } from "./vault.js";

export type MailSummary = { uid: number; from: string; subject: string; date: string; snippet: string };
export type MailAccount = { user: string; active: boolean };

type MailCreds = { user: string; pass: string; imapHost: string; smtpHost: string; smtpPort: number; smtpSecure: boolean };

function hosts() {
  return {
    imapHost: getSetting("imap_host") || "imap.gmail.com",
    smtpHost: getSetting("smtp_host") || "smtp.gmail.com",
    smtpPort: Number(getSetting("smtp_port")) || 465,
    smtpSecure: getSetting("smtp_secure") !== "0",
  };
}

function passFor(user: string): string {
  const activeUser = getSetting("email_user") || "";
  if (user.toLowerCase() === activeUser.toLowerCase()) {
    // active account: explicit setting first, then its own vault entry, then the latest stored one (legacy single-account setups)
    return getSetting("email_pass")
      || getCredential("email", user)?.secret
      || getCredential("gmail", user)?.secret
      || getCredential("email")?.secret
      || getCredential("gmail")?.secret
      || "";
  }
  return getCredential("email", user)?.secret || getCredential("gmail", user)?.secret || "";
}

function mailCreds(user?: string): MailCreds {
  const target = user || getSetting("email_user") || "";
  if (!target) throw new Error("Email not connected - say `connect email` and add your address + app password.");
  const pass = passFor(target);
  if (!pass) throw new Error(`No app password stored for ${target} - run \`connect email\` for that account.`);
  return { user: target, pass, ...hosts() };
}

export function mailConfigured(): boolean {
  try { mailCreds(); return true; } catch { return false; }
}

/** Every mail account this machine can send/read with: the active `connect email` account first, then extra vault entries. */
export function listMailAccounts(): MailAccount[] {
  const out: MailAccount[] = [];
  const seen = new Set<string>();
  const active = getSetting("email_user") || "";
  if (active && passFor(active)) {
    out.push({ user: active, active: true });
    seen.add(active.toLowerCase());
  }
  for (const svc of ["email", "gmail"]) {
    for (const cred of listCredentials().filter((c) => c.service === svc)) {
      if (!seen.has(cred.username.toLowerCase())) {
        seen.add(cred.username.toLowerCase());
        out.push({ user: cred.username, active: false });
      }
    }
  }
  return out;
}

export function findMailAccount(user: string): MailAccount | null {
  return listMailAccounts().find((a) => a.user.toLowerCase() === user.toLowerCase()) || null;
}

/** Test seam: replaced only by tests; production always reads live IMAP. */
let inboxFetcher: ((limit: number) => Promise<MailSummary[]>) | null = null;
let bodyFetcher: ((uid: number, maxChars: number) => Promise<string>) | null = null;
export function setInboxFetcherForTests(f: typeof inboxFetcher, b: typeof bodyFetcher = null) { inboxFetcher = f; bodyFetcher = b; }

const MAIL_STOPWORDS = new Set(["the", "a", "an", "mail", "email", "e-mail", "from", "about", "did", "any", "say", "says", "said", "what", "does", "do", "is", "my", "me", "show", "read", "check", "tell", "latest", "last", "recent", "new", "got", "get", "have", "has"]);

/** Filter mail summaries by a free-text query: every distinctive word must hit from/subject/snippet
 *  (alphanumeric-squash comparison so "2step" matches "2-Step"). Ranked by hits, newest kept. */
export function filterMail(msgs: MailSummary[], query: string): MailSummary[] {
  const words = query.toLowerCase().split(/[^a-z0-9@.]+/i).filter((w) => w.length > 1 && !MAIL_STOPWORDS.has(w));
  if (!words.length) return msgs;
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9@.]/g, "");
  return msgs
    .map((m) => {
      const hay = `${m.from} ${m.subject} ${m.snippet}`.toLowerCase();
      const sq = squash(hay);
      const hits = words.filter((w) => hay.includes(w) || sq.includes(squash(w))).length;
      return { m, hits };
    })
    .filter((s) => s.hits === words.length)
    .sort((a, b) => b.hits - a.hits)
    .map((s) => s.m);
}

/** Mail triage: which of the recent mails actually need HIM to reply.
 *  Deterministic, read-only scoring - automated mail (no-reply, newsletters,
 *  notifications) is excluded; direct questions and job-search signals
 *  (recruiter, interview, shortlist, offer, follow-up) rise to the top. */
const AUTOMATED_FROM = /no-?reply|donotreply|mailer-daemon|newsletter|notifications?@|updates?@|promo|marketing|digest|bounce/i;
const AUTOMATED_SUBJECT = /unsubscribe|newsletter|offer ends|flash sale|\d+% off|receipt|invoice|statement|verification code|password reset/i;
const REPLY_SIGNALS: Array<{ re: RegExp; reason: string; weight: number }> = [
  { re: /\?/, reason: "asks a direct question", weight: 2 },
  { re: /\b(please|kindly)\s+(reply|respond|confirm|let (me|us) know)/i, reason: "explicitly asks for a response", weight: 3 },
  { re: /\b(following up|follow[ -]?up|gentle reminder|bumping this)/i, reason: "someone is following up", weight: 3 },
  { re: /\b(recruiter|interview|shortlist|offer letter|hiring|your application|next steps?|assessment|coding round)/i, reason: "job-search related", weight: 3 },
  { re: /\b(deadline|due (date|by)|expires?|last date|before (eod|tomorrow))/i, reason: "has a deadline", weight: 2 },
  { re: /\b(urgent|important|action (required|needed))\b/i, reason: "marked urgent", weight: 2 },
];

export type TriageItem = MailSummary & { score: number; reasons: string[] };

export function triageMail(msgs: MailSummary[], now = Date.now()): TriageItem[] {
  const out: TriageItem[] = [];
  for (const m of msgs) {
    if (AUTOMATED_FROM.test(m.from) || AUTOMATED_SUBJECT.test(m.subject)) continue;
    const text = `${m.subject}\n${m.snippet}`;
    const hits = REPLY_SIGNALS.filter((s) => s.re.test(text));
    let score = hits.reduce((n, s) => n + s.weight, 0);
    const age = now - new Date(m.date || 0).getTime();
    if (Number.isFinite(age)) {
      if (age < 48 * 3_600_000) score += 1; // fresh mail matters more
      if (age > 14 * 86_400_000) score -= 2; // ancient threads fade
    }
    if (score > 0) out.push({ ...m, score, reasons: hits.map((s) => s.reason) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

/** Recent inbox through the test seam when set. */
export async function recentMail(limit = 30): Promise<MailSummary[]> {
  return inboxFetcher ? inboxFetcher(limit) : listInbox(limit);
}

/** Search the recent inbox (sender, subject, body snippet). Read-only. */
export async function searchMail(query: string, limit = 30): Promise<MailSummary[]> {
  const recent = await recentMail(limit);
  return filterMail(recent, query).slice(0, 5);
}

/** Full-ish body of one message (by uid). Read-only. */
export async function readMailBody(uid: number, maxChars = 2000): Promise<string> {
  if (bodyFetcher) return bodyFetcher(uid, maxChars);
  if (inboxFetcher) {
    const all = await inboxFetcher(50);
    return (all.find((x) => x.uid === uid)?.snippet || "").slice(0, maxChars);
  }
  const { user, pass, imapHost } = mailCreds();
  const client = new ImapFlow({ host: imapHost, port: 993, secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      for await (const msg of client.fetch(String(uid), { bodyParts: ["text"] }, { uid: true })) {
        return (msg.bodyParts?.get("text")?.toString("utf8") ?? "").replace(/\s+\n/g, "\n").slice(0, maxChars);
      }
      return "";
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
}

export async function listInbox(limit = 15): Promise<MailSummary[]> {
  const { user, pass, imapHost } = mailCreds();
  const client = new ImapFlow({ host: imapHost, port: 993, secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const count = client.mailbox && typeof client.mailbox === "object" ? (client.mailbox as any).exists : 0;
      if (!count) return [];
      const out: MailSummary[] = [];
      for await (const msg of client.fetch(`${Math.max(1, count - limit + 1)}:*`, { envelope: true, bodyParts: ["text"] })) {
        const env = msg.envelope!;
        const bodyText = msg.bodyParts?.get("text")?.toString("utf8") ?? "";
        out.push({
          uid: msg.uid,
          from: env.from?.[0] ? `${env.from[0].name || ""} <${env.from[0].address || ""}>`.trim() : "?",
          subject: env.subject || "(no subject)",
          date: env.date?.toISOString() ?? "",
          snippet: bodyText.replace(/\s+/g, " ").slice(0, 200),
        });
      }
      return out.reverse();
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
}

export async function sendMail(to: string, subject: string, body: string, opts: { from?: string } = {}): Promise<{ simulated: boolean; messageId?: string; from: string }> {
  const { user, pass, smtpHost, smtpPort, smtpSecure } = mailCreds(opts.from);
  const transport = nodemailer.createTransport({ host: smtpHost, port: smtpPort, secure: smtpSecure, auth: { user, pass } });
  const info = await transport.sendMail({ from: user, to, subject, text: body });
  return { simulated: false, messageId: info.messageId, from: user };
}

/** Cold-mail hub: render an outreach template with profile fields. */
export function renderColdMail(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}
