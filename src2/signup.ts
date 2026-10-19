/** Sign-up engine: drives the shared browser through a site's Google-SSO or email signup,
 *  pulls OTPs/verification links from the connected inbox, and hands CAPTCHA/2FA to the human.
 *  Plain Chromium, no evasion: if a site blocks automation, the human takes over (Browser tab). */
import { db } from "./db.js";
import { emit } from "./bus.js";
import { isUserControlling, setUserControl, detectChallenge, navigate, pageText, ensureBrowser } from "./browser.js";
import { getCredential } from "./vault.js";

export type SignupStatus = "completed" | "pending_verification" | "failed" | "needs_human";

export function recordSignup(site: string, url: string | null, method: "google_sso" | "email_password", username: string | null, status: SignupStatus): number {
  const r = db.prepare("INSERT INTO signups(ts, site, url, method, username, status) VALUES (?,?,?,?,?,?)")
    .run(Date.now(), site, url, method, username, status === "needs_human" ? "pending_verification" : status);
  return Number(r.lastInsertRowid);
}

export function listSignups(): any[] {
  return db.prepare("SELECT * FROM signups ORDER BY ts DESC LIMIT 50").all() as any[];
}

export function updateSignupStatus(id: number, status: string): boolean {
  return db.prepare("UPDATE signups SET status=? WHERE id=?").run(status, id).changes > 0;
}

/** Candidate selectors for "Continue with Google" style buttons, in priority order. */
export const GOOGLE_SSO_SELECTORS = [
  'button:has-text("Continue with Google")',
  'button:has-text("Sign up with Google")',
  'button:has-text("Sign in with Google")',
  'a:has-text("Continue with Google")',
  'a:has-text("Sign up with Google")',
  '[data-provider="google"]',
  '[aria-label*="Google" i]',
];

/** Score how likely an HTML blob contains a Google-SSO option (unit-testable, no browser). */
export function htmlHasGoogleSso(html: string): boolean {
  return /continue with google|sign (up|in) with google|accounts\.google\.com|data-provider="google"/i.test(html);
}

/** Find the first visible Google-SSO control on the current page. */
export async function findGoogleSsoButton(): Promise<boolean> {
  const page = await ensureBrowser();
  for (const sel of GOOGLE_SSO_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 800 })) { await el.click(); return true; }
    } catch { /* try next */ }
  }
  return false;
}

/** Wait for the human to finish a CAPTCHA/2FA takeover (polls every 3s, max 5 min). */
export async function waitForHuman(maxMs = 300_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (!isUserControlling() && !(await detectChallenge())) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

/** Extract an OTP for `site` from recent inbox messages (newest first). */
export async function otpFromInbox(site: string, sinceTs: number, fetchInbox: () => Promise<{ subject: string; snippet: string; date: string }[]>): Promise<string | null> {
  const { extractOtp } = await import("./otp.js");
  const msgs = await fetchInbox();
  for (const m of msgs) {
    if (new Date(m.date).getTime() < sinceTs) continue;
    const text = `${m.subject} ${m.snippet}`;
    if (site && !text.toLowerCase().includes(site.toLowerCase().split(".")[0])) {
      // still try: many OTP mails don't name the site in the first 200 chars
    }
    const code = extractOtp(text);
    if (code) return code;
  }
  return null;
}

/** Full Google-SSO signup attempt on a site. Honest about limits: reports each stage. */
export async function signupWithGoogle(runId: string, site: string): Promise<SignupStatus> {
  const log = (text: string) => emit({ ts: Date.now(), run_id: runId, kind: "status", text });
  const google = getCredential("google");
  await navigate(site);
  log(`On ${site} - looking for a Google sign-up option.`);
  if (!(await findGoogleSsoButton())) {
    const text = await pageText(1500);
    if (!htmlHasGoogleSso(text)) {
      recordSignup(site, site, "google_sso", google?.username ?? null, "failed");
      log("No Google sign-up option found on this page.");
      return "failed";
    }
  }
  const challenge = await detectChallenge();
  if (challenge) {
    log(`${challenge === "captcha" ? "CAPTCHA" : "2FA"} wall - take control in the Browser tab, solve it, then flip control back.`);
    setUserControl(true);
    const done = await waitForHuman();
    setUserControl(false);
    if (!done) { recordSignup(site, site, "google_sso", google?.username ?? null, "needs_human"); return "needs_human"; }
  }
  recordSignup(site, site, "google_sso", google?.username ?? null, "pending_verification");
  log("Google flow clicked through. If the site emailed a code, say `finish signup <site>` and I'll pull it from the inbox.");
  return "pending_verification";
}
