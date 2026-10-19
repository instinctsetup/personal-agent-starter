// Pure, unit-tested intent parsing. The chat UI also lists these commands,
// so the user always has a deterministic way to drive the agent even when
// no model provider is connected.
export type Intent =
  | { name: 'mail.list'; unseenOnly: boolean }
  | { name: 'mail.search'; query: string }
  | { name: 'mail.summarize'; count: number }
  | { name: 'mail.send' } // guided question flow collects to/subject/body
  | { name: 'apply'; url: string }
  | { name: 'applications' }
  | { name: 'remember'; text: string }
  | { name: 'recall'; query: string }
  | { name: 'forget'; id: string }
  | { name: 'notes' }
  | { name: 'remind'; raw: string }
  | { name: 'reminders' }
  | { name: 'files.list' }
  | { name: 'files.read'; name2: string }
  | { name: 'files.write'; name2: string; content: string }
  | { name: 'files.append'; name2: string; content: string }
  | { name: 'plugins' }
  | { name: 'telegram.channels' }
  | { name: 'telegram.status' }
  | { name: 'linkedin.feed' }
  | { name: 'linkedin.apply'; url: string }
  | { name: 'linkedin.message'; url: string; text: string }
  | { name: 'linkedin.invite'; url: string; note: string }
  | { name: 'linkedin.login' }
  | { name: 'linkedin.status' }
  | { name: 'help' }
  | { name: 'chat'; text: string };

const URL_RE = /https?:\/\/[^\s<>"']+/i;

export function parseIntent(raw: string): Intent {
  const text = raw.trim();
  const lower = text.toLowerCase();

  if (/^(help|\/help|commands|what can you do)\b/.test(lower)) return { name: 'help' };

  const url = text.match(URL_RE)?.[0]?.replace(/[).,;]+$/, '');

  if (url && /\bapply\b/.test(lower) && /linkedin\.com/.test(url)) return { name: 'linkedin.apply', url };
  if (url && /\bapply\b/.test(lower)) return { name: 'apply', url };
  if (url && /linkedin\.com/.test(url) && /\bmessage|msg\b/.test(lower)) {
    const after = text.slice(text.indexOf(url) + url.length).replace(/^\s*:\s*/, '').trim();
    return { name: 'linkedin.message', url, text: after };
  }
  if (url && /linkedin\.com/.test(url) && /\binvite|connect\b/.test(lower)) {
    const after = text.slice(text.indexOf(url) + url.length).replace(/^\s*:\s*/, '').trim();
    return { name: 'linkedin.invite', url, note: after };
  }

  if (/^(mail|email|inbox)\b/.test(lower) || /^(unread|new) (mail|email)/.test(lower) || /^summari[sz]e (my )?(mail|email|inbox)/.test(lower) || /check (my )?(mail|email|inbox)/.test(lower)) {
    const m = lower.match(/search (?:for )?(.+)/);
    if (m) return { name: 'mail.search', query: m[1].trim() };
    if (/summari[sz]e/.test(lower)) {
      const n = lower.match(/(\d+)/);
      return { name: 'mail.summarize', count: n ? Number(n[1]) : 3 };
    }
    if (/send|write|compose/.test(lower)) return { name: 'mail.send' };
    return { name: 'mail.list', unseenOnly: /unread|new/.test(lower) };
  }
  if (/search (my )?(mail|email|inbox) (for )?(.+)/.test(lower)) {
    return { name: 'mail.search', query: lower.match(/search (?:my )?(?:mail|email|inbox) (?:for )?(.+)/)![1].trim() };
  }
  if (/^(send|write|compose) (a |an )?(mail|email)/.test(lower)) return { name: 'mail.send' };

  if (/telegram/.test(lower)) {
    if (/channel|read|posts|latest/.test(lower)) return { name: 'telegram.channels' };
    return { name: 'telegram.status' };
  }

  if (/linkedin/.test(lower)) {
    if (/feed|posts/.test(lower)) return { name: 'linkedin.feed' };
    if (/log ?in|login|sign ?in/.test(lower)) return { name: 'linkedin.login' };
    if (/status|cap|limit/.test(lower)) return { name: 'linkedin.status' };
    if (/feed/.test(lower)) return { name: 'linkedin.feed' };
    return { name: 'linkedin.status' };
  }

  if (/application(s)? (log|history|status)|what did you apply|my applications/.test(lower)) return { name: 'applications' };

  const rem = text.match(/^remember(?: that)?\s+(.+)$/is);
  if (rem) return { name: 'remember', text: rem[1].trim() };
  const rec = lower.match(/^(?:recall|what do you (?:know|remember) about)\s+(.+)/);
  if (rec) return { name: 'recall', query: rec[1].trim() };
  const forg = lower.match(/^forget\s+(?:note\s+)?([a-z0-9-]+)/);
  if (forg) return { name: 'forget', id: forg[1] };
  if (/^(notes|my notes|list notes)\b/.test(lower)) return { name: 'notes' };

  if (/^remind(er)? me\b/.test(lower) || /^remind me\b/.test(lower)) return { name: 'remind', raw: text };
  if (/^(reminders|my reminders|list reminders)\b/.test(lower)) return { name: 'reminders' };

  if (/^(list |show )?(workspace )?files\b/.test(lower)) return { name: 'files.list' };
  const fr = text.match(/^(?:read|show|open) (?:file )?([\w.\-/]+)$/i);
  if (fr && /file|read|show|open/i.test(lower)) return { name: 'files.read', name2: fr[1] };
  const fw = text.match(/^(?:write|create|save) (?:file )?([\w.\-/]+)\s*:\s*([\s\S]+)$/i);
  if (fw) return { name: 'files.write', name2: fw[1], content: fw[2] };
  const fa = text.match(/^append (?:to )?(?:file )?([\w.\-/]+)\s*:\s*([\s\S]+)$/i);
  if (fa) return { name: 'files.append', name2: fa[1], content: fa[2] };
  if (/^plugins\b/.test(lower)) return { name: 'plugins' };

  return { name: 'chat', text };
}
