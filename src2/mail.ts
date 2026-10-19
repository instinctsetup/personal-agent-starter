/** Inbox read (IMAP) + send (SMTP) using settings + vault-stored app password. Sending is approval-gated in agent2. */
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { getSetting } from "./db.js";
import { getCredential } from "./vault.js";

export type MailSummary = { uid: number; from: string; subject: string; date: string; snippet: string };

function mailCreds(): { user: string; pass: string; imapHost: string; smtpHost: string } {
  const user = getSetting("email_user") || "";
  const imapHost = getSetting("imap_host") || "imap.gmail.com";
  const smtpHost = getSetting("smtp_host") || "smtp.gmail.com";
  const pass = getSetting("email_pass") || getCredential("email")?.secret || getCredential("gmail")?.secret || "";
  if (!user || !pass) throw new Error("Email not connected - say `connect email` and add your address + app password.");
  return { user, pass, imapHost, smtpHost };
}

export function mailConfigured(): boolean {
  try { mailCreds(); return true; } catch { return false; }
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

export async function sendMail(to: string, subject: string, body: string): Promise<{ simulated: boolean; messageId?: string }> {
  const { user, pass, smtpHost } = mailCreds();
  const transport = nodemailer.createTransport({ host: smtpHost, port: 465, secure: true, auth: { user, pass } });
  const info = await transport.sendMail({ from: user, to, subject, text: body });
  return { simulated: false, messageId: info.messageId };
}

/** Cold-mail hub: render an outreach template with profile fields. */
export function renderColdMail(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}
