/** Live browser engine: one persistent Playwright context the daemon drives and the UI watches. */
import { chromium, type BrowserContext, type Page } from "playwright";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { DATA_DIR } from "./db.js";

let context: BrowserContext | null = null;
let page: Page | null = null;
let userControl = false; // when true, agent pauses automation so the human can solve CAPTCHA/2FA

export function isUserControlling(): boolean { return userControl; }
export function setUserControl(v: boolean): void { userControl = v; }

export async function ensureBrowser(): Promise<Page> {
  if (page && !page.isClosed()) return page;
  // Track the context itself: for a persistent context, context.browser() is null, so
  // keying off a Browser handle silently relaunched a second context on the same
  // profile dir whenever the page had been closed (profile-lock errors, lost state).
  if (!context) {
    mkdirSync(join(DATA_DIR, "browser-profile"), { recursive: true });
    context = await chromium.launchPersistentContext(join(DATA_DIR, "browser-profile"), {
      headless: true,
      // Plain Chromium, no stealth or fingerprint spoofing: default UA, default flags,
      // no webdriver-property patching. Sites see this exactly as an automated browser.
      args: ["--no-sandbox"],
      viewport: { width: 1280, height: 800 },
    });
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

export async function closeBrowser(): Promise<void> {
  await context?.close().catch(() => {});
  context = null; page = null;
}
