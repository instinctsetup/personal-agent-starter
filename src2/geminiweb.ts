/**
 * EXPERIMENTAL: drive the gemini.google.com web app with the shared browser
 * profile as a last-resort model when every API is down.
 *
 * Why it exists: a Google AI Pro/Ultra subscription raises limits only inside
 * Google's own web apps, not for API keys - so a spare logged-in Google account
 * can still answer through the website when the free API is 503ing.
 *
 * Rules baked in (these are the terms the user accepted):
 * - OFF by default; only runs when `connect gemini-web` was used to enable it.
 * - Login is done by the user, by hand, in the Browser tab. We never see or
 *   store the password.
 * - Slow pacing: at most one web call per PACE_MS, one at a time.
 * - Clearly labelled experimental: Google can change the page or block
 *   automation at any time; failures must degrade gracefully.
 */
import { getSetting } from "./db.js";

export const GEMINI_WEB_PACE_MS = Number(process.env.GEMINI_WEB_PACE_MS) || 20_000;
const RESPOND_TIMEOUT_MS = Number(process.env.GEMINI_WEB_TIMEOUT_MS) || 120_000;

let lastCallAt = 0;
let inFlight: Promise<string> | null = null;

export function geminiWebEnabled(): boolean {
  return getSetting("gemini_web_enabled") === "1";
}

/** Flatten a chat history into one plain prompt for the web editor. */
export function flattenMessages(messages: { role: string; content: string }[]): string {
  return messages
    .map((m) => (m.role === "system" ? `Instructions: ${m.content}` : m.role === "assistant" ? `You said: ${m.content}` : m.content))
    .join("\n\n");
}

/** Milliseconds the next web call must still wait (0 = go). Exported for tests. */
export function paceWaitMs(now = Date.now()): number {
  return Math.max(0, lastCallAt + GEMINI_WEB_PACE_MS - now);
}

type Impl = (prompt: string, signal?: AbortSignal) => Promise<string>;
let impl: Impl | null = null;
/** Tests substitute a fake; production leaves impl null and the real driver runs. */
export function __setGeminiWebChatForTests(fn: Impl | null) { impl = fn; }

export async function geminiWebChat(prompt: string, signal?: AbortSignal): Promise<string> {
  if (impl) return impl(prompt, signal);
  if (!geminiWebEnabled()) throw new Error("gemini-web is off. Say `connect gemini-web` to enable the experimental web provider.");
  if (inFlight) return inFlight;
  inFlight = (async () => {
    if (signal?.aborted) throw new Error("cancelled - another model answered first");
    const wait = paceWaitMs();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (signal?.aborted) throw new Error("cancelled - another model answered first");
    lastCallAt = Date.now();
    const br = await import("./browser.js");
    await br.navigate("https://gemini.google.com/app");
    const page = await br.ensureBrowser();
    // login wall?
    if (/accounts\.google\.com/.test(page.url())) {
      throw new Error("gemini-web needs a one-time login: open the Browser tab, take control, sign into the spare Google account, then try again.");
    }
    const editor = page.locator("div[contenteditable='true'], textarea").first();
    await editor.waitFor({ timeout: 15_000 }).catch(() => {
      throw new Error("could not find the Gemini input box - the page layout may have changed (experimental provider), or you need to log in via the Browser tab.");
    });
    const before = await page.locator(".response-container, message-content, .markdown").count().catch(() => 0);
    await editor.click();
    await editor.pressSequentially(prompt.slice(0, 4000), { delay: 8 });
    await page.keyboard.press("Enter");
    // wait for a new response block to appear and stop growing
    const deadline = Date.now() + RESPOND_TIMEOUT_MS;
    let stable = 0;
    let lastText = "";
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const blocks = page.locator(".response-container, message-content, .markdown");
      const count = await blocks.count().catch(() => 0);
      if (count <= before) continue;
      const text = (await blocks.last().innerText().catch(() => "")) || "";
      if (text && text === lastText) {
        if (++stable >= 3) return text.trim();
      } else {
        stable = 0;
        lastText = text;
      }
    }
    throw new Error("gemini-web timed out waiting for the answer (the site may be slow or showing a challenge - check the Browser tab).");
  })().finally(() => { inFlight = null; });
  return inFlight;
}
