/** Intent matchers + per-channel recent-turns buffer, extracted from agent2.ts (barrel split,
 *  step 1 - behavior unchanged; agent2 re-exports everything so existing imports keep working). */
import { isKnownApp } from "./winops.js";

export type ChannelId = string;
export const DEFAULT_CHANNEL: ChannelId = "web";

/** Recent turns per channel, so the router and the deterministic follow-up matcher can resolve
 *  "answer all", "submit", "it is in the form" against what was JUST said - the circular
 *  "which form? - the one I pasted - which form?" bug was this buffer not existing. */
export const recentTurns = new Map<ChannelId, { role: "user" | "agent"; text: string; ts: number }[]>();
export const runChannel = new Map<string, ChannelId>();

export function rememberTurn(channel: ChannelId, role: "user" | "agent", text: string): void {
  const a = recentTurns.get(channel) || [];
  a.push({ role, text: text.slice(0, 500), ts: Date.now() });
  recentTurns.set(channel, a.slice(-8));
}

/** Last few turns of this channel as prompt context ("user: ... / you: ..."). */
export function recentContext(channel: ChannelId, max = 6): string {
  const a = (recentTurns.get(channel) || []).slice(-max);
  return a.map((t) => `${t.role === "user" ? "User" : "You"}: ${t.text}`).join("\n");
}

const FORMS_URL_RE = /https?:\/\/\S*(?:docs\.google\.com\/forms|forms\.gle)\S*/i;

/** The most recent Google-Forms URL mentioned on this channel, newest turn first. */
export function recentFormsUrl(channel: ChannelId): string | null {
  for (const t of [...(recentTurns.get(channel) || [])].reverse()) {
    const m = t.text.match(FORMS_URL_RE);
    if (m) return m[0].replace(/[.,:;!)]+$/, "");
  }
  return null;
}

/** Deterministic form-flow routing. A pasted Google-Forms URL IS the command; short action
 *  follow-ups resolve against the last form URL on the channel. Returns the canonical command. */
export function matchFormFlowCommand(cmd: string, channel: ChannelId = DEFAULT_CHANNEL): string | null {
  const url = cmd.match(FORMS_URL_RE)?.[0]?.replace(/[.,:;!)]+$/, "");
  if (url) return `fill form ${url}`;
  if (/^(?:answer (?:all|them|all the questions?|everything)|submit|fill it|fill (?:the|this|out)(?: form)?|do it|go ahead|yes(?: submit)?|it is in the form|it'?s in the form|answer all and submit|open it)[.!? ]*$/i.test(cmd.trim())) {
    const recent = recentFormsUrl(channel);
    if (recent) return `fill form ${recent}`;
  }
  return null;
}

/** Unambiguous local/system questions are commands, not conversation. Deterministic - beats a flaky
 * router model (a free-tier router model returned "chat" for "laptop status" and the user got a
 * denial instead of his battery level). Returns the canonical command to execute. */
export function matchSystemCommand(cmd: string): string | null {
  const c = cmd.trim().replace(/[?!.\s]+$/, "");
  if (/^(?:system info|sys ?info|laptop status|battery(?: status| level)?|how'?s my (?:laptop|pc|computer)(?: doing)?|how is my (?:laptop|pc|computer)(?: doing)?)$/i.test(c)) return "laptop status";
  if (/^(?:what'?s|whats) on my clipboard$/i.test(c) || /^clipboard$/i.test(c)) return "what's on my clipboard";
  if (/^(?:quota|quotas|model usage|api usage|usage)$/i.test(c)) return "quota";
  if (/^linkedin (?:crm|pipeline|outreach)$/i.test(c)) return "linkedin crm";
  if (/^linkedin follow ?ups?$/i.test(c) || /^who should i follow up with$/i.test(c)) return "linkedin follow ups";
  if (/^(?:what needs a reply|mail triage|triage|anything needs? (?:a )?(?:reply|response)|who'?s waiting on (?:me|a reply))$/i.test(c)) return "what needs a reply";
  if (/^notes$/i.test(c)) return "notes";
  if (/^(?:file history|file ops|what files did i (?:move|rename|delete|change))$/i.test(c)) return "file history";
  if (/^(?:use my real browser|real browser)$/i.test(c)) return "use my real browser";
  if (/^browser (?:status|bundled)$/i.test(c)) return c.toLowerCase();
  if (/^(?:version|what version|which version)(?: are you(?: running)?)?$/i.test(c)) return "version";
  const mOpen = c.match(/^open ([a-z0-9 ]{2,25})$/i);
  if (mOpen && isKnownApp(mOpen[1].trim()) && !/[./]/.test(mOpen[1])) return `open ${mOpen[1].trim()}`;
  return null;
}

/** Mail questions are commands, not conversation. Deterministic - beats a flaky router model. */
export function matchMailQuery(cmd: string): { query: string; latest?: boolean } | null {
  const canonical = cmd.match(/^mail search\s+(.+)$/i) || cmd.match(/^mail from\s+(.+)$/i);
  if (canonical) return { query: canonical[1].trim() };
  if (/^latest (?:e-?mail|mail)$/i.test(cmd)) return { query: "", latest: true };
  if (/^(send|connect|draft|write|compose|reply)\b/i.test(cmd)) return null;
  let m = cmd.match(/^(?:what does|what's|whats)\s+(?:the\s+)?(.+?)\s+(?:e-?mail|mail)\s+say/i);
  if (m) return { query: m[1].trim() };
  m = cmd.match(/\bany\s+(?:reply|response|mail|e-?mail|news)\s+from\s+(.+?)[.?!]?$/i);
  if (m) return { query: m[1].trim() };
  m = cmd.match(/^(?:did|has|have)\s+(.+?)\s+(?:reply|replied|respond|write|written|send|sent|mail)(?:\s+back)?/i);
  if (m) return { query: m[1].trim() };
  m = cmd.match(/^(?:summari[sz]e|read|show)\s+(?:my\s+|the\s+)?(last|latest|recent)\s+(?:e-?mails?|mails?|inbox)$/i);
  if (m) return { query: "", latest: true };
  m = cmd.match(/^(?:summari[sz]e|read|show)\s+(?:my\s+|the\s+)?(.+?)\s+(?:e-?mail|mail)$/i);
  if (m) return { query: m[1].trim() };
  m = cmd.match(/^latest\s+(?:e-?mail|mail)\s+from\s+(.+)$/i);
  if (m) return { query: m[1].trim() };
  return null;
}

/** Parse "linkedin message <profile-url>: <text>" / "message <url> on linkedin saying ..." / "connect with <url> on linkedin note: ...". */
export function parseLinkedinAsk(cmd: string): { kind: "message" | "invite"; url: string; text: string } | null {
  const url = cmd.match(/https?:\/\/[\w.]*linkedin\.com\/[^\s]+/i)?.[0]?.replace(/[.,:;!)]+$/, "");
  if (!url) return null;
  const rest = cmd.replace(url, " ").trim();
  const kind = /\b(message|msg|dm)\b/i.test(rest) ? "message" as const
    : /\b(connect|invite|add)\b/i.test(rest) ? "invite" as const
    : null;
  if (!kind) return null;
  const after = cmd.slice(cmd.indexOf(url) + url.length).replace(/^\s*(?:,)?\s*(?:on\s+linkedin\s+)?(?:saying|that|to say|note\s*:|:)\s*/i, "").trim();
  if (kind === "message" && !after) return null; // a DM needs its text
  return { kind, url, text: after };
}

