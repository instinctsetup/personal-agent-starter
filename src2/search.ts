/** Keyless web search with provider fallback: DuckDuckGo HTML, then Bing (wrapped-url decode). */
export type SearchResult = { title: string; url: string; snippet: string };

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const blocks = html.split(/class="result results_links/);
  for (let i = 1; i < blocks.length && out.length < 10; i++) {
    const b = blocks[i];
    const a = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = a[1].replace(/&amp;/g, "&");
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    const snip = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    out.push({ title: stripTags(a[2]), url, snippet: snip ? stripTags(snip[1]) : "" });
  }
  return out;
}

function decodeBingUrl(href: string): string {
  const m = href.match(/[?&]u=a1([^&]+)/);
  if (!m) return href;
  try {
    let b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const dec = Buffer.from(b64, "base64").toString("utf8");
    if (dec.startsWith("http")) return dec;
  } catch { /* keep wrapped */ }
  return href;
}

export function parseBingHtml(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const blocks = html.split('<li class="b_algo"');
  for (let i = 1; i < blocks.length && out.length < 10; i++) {
    const b = blocks[i];
    const a = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = decodeBingUrl(a[1].replace(/&amp;/g, "&"));
    const snip = b.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/) || b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title: stripTags(a[2]), url, snippet: snip ? stripTags(snip[1]) : "" });
  }
  return out;
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

/** Search the web without API keys. Tries DuckDuckGo, then Bing. Returns [] when all providers block us. */
export async function webSearch(query: string): Promise<SearchResult[]> {
  const ddg = await fetchHtml(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  if (ddg) {
    const r = parseDuckDuckGoHtml(ddg);
    if (r.length) return r;
  }
  const bing = await fetchHtml(`https://www.bing.com/search?q=${encodeURIComponent(query)}`);
  if (bing) return parseBingHtml(bing);
  return [];
}
