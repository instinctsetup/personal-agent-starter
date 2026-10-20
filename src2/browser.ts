/** Live browser engine: one persistent Playwright context the daemon drives and the UI watches. */
import { chromium, type BrowserContext, type Page, type CDPSession } from "playwright";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { DATA_DIR, getSetting, setSetting } from "./db.js";

/** Which browser binary backs the shared context. "bundled" = Playwright Chromium (headless);
 *  "msedge"/"chrome" = his REAL installed browser (headed window, own automation profile).
 *  Google blocks sign-in on bundled automation Chromium ("this browser may not be secure") -
 *  a real Edge/Chrome binary passes because it IS a normal browser he logs into himself. */
export type BrowserChannel = "bundled" | "msedge" | "chrome";

/** Standard install locations (used by the doctor check and "use my real browser"). */
export function installedBrowsers(platform = process.platform, env: Record<string, string | undefined> = process.env): { edge: boolean; chrome: boolean } {
  if (platform !== "win32") return { edge: false, chrome: false };
  const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const pf = env["ProgramFiles"] || "C:\\Program Files";
  // Chrome's installer defaults to a PER-USER install under %LocalAppData% whenever it
  // runs without admin rights - the exact no-admin machine this app targets - and many
  // Edge installs land there too. Check both machine-wide and per-user locations.
  const local = env["LocalAppData"] || join(env["USERPROFILE"] || "C:\\Users\\Default", "AppData", "Local");
  const edgePaths = [pf86, pf, local].map((b) => join(b, "Microsoft", "Edge", "Application", "msedge.exe"));
  const chromePaths = [pf, pf86, local].map((b) => join(b, "Google", "Chrome", "Application", "chrome.exe"));
  return {
    edge: edgePaths.some((p) => existsSync(p)),
    chrome: chromePaths.some((p) => existsSync(p)),
  };
}

/** Pick the best real browser: Edge first (every Windows 11 has it), then Chrome. */
export function pickRealBrowser(avail: { edge: boolean; chrome: boolean }): BrowserChannel | null {
  return avail.edge ? "msedge" : avail.chrome ? "chrome" : null;
}

export function browserChannel(): BrowserChannel {
  const v = getSetting("browser_channel");
  return v === "msedge" || v === "chrome" ? v : "bundled";
}
export function setBrowserChannel(ch: BrowserChannel): void { setSetting("browser_channel", ch); }

export function browserProfileDir(channel: BrowserChannel): string {
  return join(DATA_DIR, channel === "bundled" ? "browser-profile" : `browser-profile-${channel}`);
}

let context: BrowserContext | null = null;
let page: Page | null = null;
let userControl = false; // when true, agent pauses automation so the human can solve CAPTCHA/2FA

export function isUserControlling(): boolean { return userControl; }
export function setUserControl(v: boolean): void { userControl = v; }

let launchInFlight: Promise<BrowserContext> | null = null;

async function launchContext(): Promise<BrowserContext> {
  const channel = browserChannel();
  const dir = browserProfileDir(channel);
  mkdirSync(dir, { recursive: true });
  if (channel === "bundled") {
    return chromium.launchPersistentContext(dir, {
      headless: true,
      // Plain Chromium, no stealth or fingerprint spoofing: default UA, default flags,
      // no webdriver-property patching. Sites see this exactly as an automated browser.
      args: ["--no-sandbox"],
      viewport: { width: 1280, height: 800 },
    });
  }
  // Real installed Edge/Chrome, HEADED (a normal window on his laptop - he signs into
  // Google there himself once; the dedicated automation profile keeps it separate from
  // his personal browser profile). No flag games, no UA spoofing.
  try {
    return await chromium.launchPersistentContext(dir, {
      channel,
      headless: false,
      viewport: { width: 1280, height: 800 },
    });
  } catch (err: any) {
    throw new Error(`Couldn't launch the real ${channel === "msedge" ? "Microsoft Edge" : "Chrome"} (${err?.message || err}). Say \`browser bundled\` to switch back to the built-in browser.`);
  }
}

export async function ensureBrowser(): Promise<Page> {
  if (page && !page.isClosed()) return page;
  // Track the context itself: for a persistent context, context.browser() is null, so
  // keying off a Browser handle silently relaunched a second context on the same
  // profile dir whenever the page had been closed (profile-lock errors, lost state).
  if (!context) {
    // Memoize the in-flight launch so concurrent callers (Browser-tab polling, a
    // scheduled job, and a chat command firing around the same tick) share one
    // launch instead of racing two launchPersistentContext calls onto the same
    // profile dir (profile-lock error).
    if (!launchInFlight) {
      launchInFlight = launchContext().finally(() => { launchInFlight = null; });
    }
    context = await launchInFlight;
  }
  const pages = context.pages();
  page = pages.find((p) => !p.isClosed()) ?? (await context.newPage());
  return page;
}

export async function navigate(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const p = await ensureBrowser();
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  return p.url();
}

export async function screenshot(): Promise<Buffer> {
  const p = await ensureBrowser();
  return p.screenshot({ type: "jpeg", quality: 70 });
}

export async function clickAt(x: number, y: number): Promise<void> {
  const p = await ensureBrowser();
  await p.mouse.click(x, y);
}

export async function typeText(text: string): Promise<void> {
  const p = await ensureBrowser();
  await p.keyboard.type(text);
}

export async function scrollBy(dx: number, dy: number): Promise<void> {
  const p = await ensureBrowser();
  await p.mouse.wheel(dx, dy);
}

export async function goBack(): Promise<string> {
  const p = await ensureBrowser();
  await p.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
  return p.url();
}

export async function goForward(): Promise<string> {
  const p = await ensureBrowser();
  await p.goForward({ waitUntil: "domcontentloaded" }).catch(() => {});
  return p.url();
}

export async function pressKey(key: string): Promise<void> {
  const p = await ensureBrowser();
  await p.keyboard.press(key);
}

export async function currentUrl(): Promise<string | null> {
  if (!page || page.isClosed()) return null;
  return page.url();
}

export async function pageText(max = 4000): Promise<string> {
  const p = await ensureBrowser();
  const text = await p.evaluate(() => document.body?.innerText ?? "");
  return text.slice(0, max);
}

/** Detect common "prove you're human" / 2FA walls so the agent can hand control to the user. */
export async function detectChallenge(): Promise<string | null> {
  if (!page || page.isClosed()) return null;
  const html = (await page.content()).toLowerCase();
  if (html.includes("g-recaptcha") || html.includes("hcaptcha") || html.includes("cf-challenge")) return "captcha";
  if (/two[- ]factor|2fa|verification code|authenticator/.test(html)) return "2fa";
  return null;
}

/** Drop the current context so the next ensureBrowser() relaunches on the current channel. */
export async function restartBrowser(): Promise<void> {
  await closeBrowser();
}

export async function closeBrowser(): Promise<void> {
  stopScreencast();
  await context?.close().catch(() => {});
  context = null; page = null;
}

// ---- CDP screencast: push live frames instead of polling screenshots ---------
let cdp: CDPSession | null = null;
let castQuality = 60;
let slowStreak = 0;
export const castStats = { frames: 0, startedAt: 0, quality: 60 };

export function isScreencasting(): boolean {
  return cdp !== null;
}

/** Consumer tells us it is dropping frames; lower quality to catch up. */
export function noteSlowConsumer(): void {
  if (!cdp || castQuality <= 25) return;
  if (++slowStreak < 3) return;
  slowStreak = 0;
  castQuality = Math.max(25, castQuality - 15);
  castStats.quality = castQuality;
  cdp.send("Page.startScreencast", { format: "jpeg", quality: castQuality, everyNthFrame: 1 }).catch(() => {});
}

/**
 * Stream JPEG frames of the current page. Backpressure is the CDP contract:
 * Chrome waits for screencastFrameAck before sending the next frame, so we ack
 * only after the consumer has handled the frame - the stream self-paces.
 */
export async function startScreencast(onFrame: (jpeg: Buffer) => void | Promise<void>): Promise<void> {
  const p = await ensureBrowser();
  stopScreencast();
  cdp = await p.context().newCDPSession(p);
  castQuality = 60;
  slowStreak = 0;
  castStats.frames = 0;
  castStats.startedAt = Date.now();
  castStats.quality = castQuality;
  const session = cdp;
  session.on("Page.screencastFrame", async (ev: { data: string; sessionId: number }) => {
    if (cdp !== session) return;
    try {
      castStats.frames++;
      await onFrame(Buffer.from(ev.data, "base64"));
    } catch { /* consumer errors must not stall the stream */ }
    session.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
  });
  await session.send("Page.startScreencast", { format: "jpeg", quality: castQuality, everyNthFrame: 1 });
}

export function stopScreencast(): void {
  const session = cdp;
  cdp = null;
  if (session) {
    session.send("Page.stopScreencast").catch(() => {});
    session.detach().catch(() => {});
  }
}
