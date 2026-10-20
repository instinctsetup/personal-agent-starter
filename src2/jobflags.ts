/** Hunt ranking helpers: cross-board de-dup and scam-pattern flagging.
 *  Read-only: results are annotated and re-ordered, never dropped silently -
 *  a flagged posting is shown with its warning, a cross-board duplicate is
 *  collapsed into the first sighting with a note. */

export type FlaggedResult = { title: string; url: string; snippet: string; flags: string[]; dupOf?: number };

/** Strip tracking junk so the same posting URL on two portals canonicalizes together. */
export function canonicalUrl(u: string): string {
  try {
    const url = new URL(u);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|refId|trackingId|source$)/i.test(key)) url.searchParams.delete(key);
    }
    return (url.origin + url.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

const SCAM_PATTERNS: Array<{ re: RegExp; flag: string }> = [
  { re: /\b(earn|make)\s+\$\s?[\d,]+\s*(a|per)\s*(day|week|month)/i, flag: "promises fixed earnings" },
  { re: /\bno experience (needed|required)\b.*\b(earn|\$)/i, flag: "'no experience' + money pitch" },
  { re: /\b(registration|joining|training|processing|security)\s+(fee|deposit|charge)/i, flag: "asks for an upfront fee" },
  { re: /\b(pay|send|transfer)\s+(money|us)\s+(first|to|via)/i, flag: "asks for money" },
  { re: /\b(whatsapp|telegram)\s+(us\s+)?(at|only|to apply|for details)\b/i, flag: "moves contact to WhatsApp/Telegram" },
  { re: /\bhiring immediately\b.*\bno interview/i, flag: "'no interview' hire" },
  { re: /\b(crypto|forex|bitcoin|investment)\s+(trading|opportunit|scheme)/i, flag: "crypto/forex pitch" },
  { re: /\bguaranteed (income|job|placement|hiring)\b/i, flag: "'guaranteed' job claim" },
  { re: /\bdata entry\b.*\b(earn|\$\d)/i, flag: "classic data-entry bait" },
];

export function scamFlags(r: { title: string; snippet: string }): string[] {
  const text = `${r.title}\n${r.snippet}`;
  return SCAM_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.flag);
}

const STALE_RE = /(\d+)\s*\+?\s*days?\s+ago/i;

export function staleDays(r: { snippet: string }): number | null {
  const m = r.snippet.match(STALE_RE);
  return m ? Number(m[1]) : null;
}

/** Dedupe by canonical URL, then by normalized title; flag scams; push flagged + stale
 *  results to the bottom. Returns the annotated list with 1-based display order. */
export function rankResults(results: Array<{ title: string; url: string; snippet: string }>): FlaggedResult[] {
  const byUrl = new Map<string, number>();
  const byTitle = new Map<string, number>();
  const out: FlaggedResult[] = [];
  for (const r of results) {
    const cu = canonicalUrl(r.url);
    const nt = normalizeTitle(r.title);
    const urlIdx = byUrl.get(cu);
    const titleIdx = byTitle.get(nt);
    const flags = scamFlags(r);
    const stale = staleDays(r);
    if (stale !== null && stale > 30) flags.push(`posted ${stale} days ago - likely stale`);
    if (urlIdx !== undefined || titleIdx !== undefined) {
      out.push({ ...r, flags, dupOf: (urlIdx ?? titleIdx)! + 1 });
      continue;
    }
    byUrl.set(cu, out.length);
    if (nt) byTitle.set(nt, out.length);
    out.push({ ...r, flags });
  }
  // scams and stale postings sink below clean ones; duplicates sink below everything
  const score = (r: FlaggedResult) => (r.dupOf ? 2 : r.flags.length ? 1 : 0);
  return out
    .map((r, i) => ({ r, i }))
    .sort((a, b) => score(a.r) - score(b.r) || a.i - b.i)
    .map(({ r }) => r);
}
