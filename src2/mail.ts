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
