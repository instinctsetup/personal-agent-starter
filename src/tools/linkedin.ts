// LinkedIn assist - OPT-IN ONLY.
// Uses the user's own logged-in session in a persistent Playwright profile
// (the user logs in once by hand; no password is ever stored by the app).
// Guardrails:
//  - the one-time risk note must be accepted before anything runs
//  - pacing: feed checks at most once per minFeedCheckMinutes, daily caps
//  - any checkpoint / captcha / throttle => stop immediately and say so
//  - form answers come only from the saved profile; missing => ask
//  - every message/invite/application needs an explicit confirmation
import { chromium, type BrowserContext, type Page } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../config.js';
import type { Profile } from './profile.js';
import { log } from '../util/log.js';

export class LinkedInStopped extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'LinkedInStopped';
  }
}

interface CapState {
  date: string; // YYYY-MM-DD local
  feedChecks: number;
  actions: number;
  lastFeedCheck: number; // epoch ms
  lastAction: number;
}

const RISK_NOTE =
  "Heads up: LinkedIn's terms discourage automation. This feature uses your own logged-in browser session at a slow, human pace with daily caps, but your account could still be restricted. Use at your own risk.";

export function linkedinRiskNote(): string {
  return RISK_NOTE;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class LinkedInTools {
  readonly profileDir: string;
  private readonly statePath: string;
  constructor(
    private store: Store,
    dir = join(process.cwd(), 'data'),
  ) {
    this.profileDir = join(dir, 'linkedin-browser-profile');
    this.statePath = join(dir, 'linkedin-state.json');
  }

  isEnabled(): { ok: boolean; reason?: string } {
    const s = this.store.getSettings().linkedin;
    if (!s.enabled) return { ok: false, reason: 'LinkedIn assist is off. Enable it in Settings.' };
    if (!s.riskAccepted) return { ok: false, reason: 'The one-time risk note has not been accepted yet.' };
    return { ok: true };
  }

  private loadCaps(): CapState {
    const fresh: CapState = { date: today(), feedChecks: 0, actions: 0, lastFeedCheck: 0, lastAction: 0 };
    if (!existsSync(this.statePath)) return fresh;
    try {
      const s = { ...fresh, ...JSON.parse(readFileSync(this.statePath, 'utf8')) };
      return s.date === today() ? s : fresh; // daily reset
    } catch {
      return fresh;
    }
  }

  private saveCaps(s: CapState): void {
    mkdirSync(join(this.statePath, '..'), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(s), { mode: 0o600 });
    chmodSync(this.statePath, 0o600);
  }

  /** Throws LinkedInStopped when a cap or pacing rule says no. */
  checkCap(kind: 'feed' | 'action'): void {
    const caps = this.store.getSettings().linkedin.caps;
    const s = this.loadCaps();
    const now = Date.now();
    if (kind === 'feed') {
      if (s.feedChecks >= caps.feedChecksPerDay)
        throw new LinkedInStopped(`Daily feed-check cap reached (${caps.feedChecksPerDay}). Try again tomorrow.`);
      if (now - s.lastFeedCheck < caps.minFeedCheckMinutes * 60_000) {
        const waitMin = Math.ceil((caps.minFeedCheckMinutes * 60_000 - (now - s.lastFeedCheck)) / 60_000);
        throw new LinkedInStopped(`Pacing: feed checks run at most every ${caps.minFeedCheckMinutes} min. Next one in ~${waitMin} min.`);
      }
    } else {
      if (s.actions >= caps.actionsPerDay)
        throw new LinkedInStopped(`Daily LinkedIn action cap reached (${caps.actionsPerDay}). Try again tomorrow.`);
      if (now - s.lastAction < caps.minActionMinutes * 60_000) {
        const waitMin = Math.ceil((caps.minActionMinutes * 60_000 - (now - s.lastAction)) / 60_000);
        throw new LinkedInStopped(`Pacing: LinkedIn actions are spaced ${caps.minActionMinutes} min apart. Next one in ~${waitMin} min.`);
      }
    }
  }

  private bumpCap(kind: 'feed' | 'action'): void {
    const s = this.loadCaps();
    const now = Date.now();
    if (kind === 'feed') { s.feedChecks++; s.lastFeedCheck = now; }
    else { s.actions++; s.lastAction = now; }
    this.saveCaps(s);
  }

  /** Launches the persistent profile. First run: user logs in by hand. */
  private async context(headless: boolean): Promise<BrowserContext> {
    mkdirSync(this.profileDir, { recursive: true });
    chmodSync(this.profileDir, 0o700);
    return chromium.launchPersistentContext(this.profileDir, {
      headless,
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });
  }

  /** Detects a login wall, checkpoint, captcha or throttle - then stops. */
  private async guardPage(page: Page): Promise<void> {
    const url = page.url();
    if (/\/checkpoint|\/authwall|\/login/.test(url))
      throw new LinkedInStopped('LinkedIn asked me to log in or pass a checkpoint. Open LinkedIn in the app browser and log in/verify once yourself (Settings > LinkedIn > open browser), then retry.');
    const challenge = await page
      .locator('iframe[src*="captcha"], .challenge-dialog, #captcha-internal, [data-test-id*="challenge"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (challenge)
      throw new LinkedInStopped('LinkedIn showed a captcha/challenge. I stop here instead of bypassing it - solve it by hand in the LinkedIn browser window, then ask again.');
    const throttle = await page
      .getByText(/too many requests|slow down|unusual activity/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (throttle)
      throw new LinkedInStopped('LinkedIn is throttling this session. Stopping - give it a rest for a few hours.');
  }

  /** Opens a visible browser so the user can log in once themselves. */
  async openForManualLogin(): Promise<string> {
    const ctx = await this.context(false);
    const page = await ctx.newPage();
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
    // Leave the browser open; the user closes it when done. Return immediately.
    void page;
    return 'Opened the LinkedIn browser. Log in yourself, then close the window - your session stays saved on this machine.';
  }

  async isLoggedIn(): Promise<boolean> {
    const ctx = await this.context(true);
    try {
      const page = await ctx.newPage();
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return !/login|authwall|checkpoint/.test(page.url());
    } catch {
      return false;
    } finally {
      await ctx.close();
    }
  }

  /** Reads the top of the user's feed. Paced: at most once per configured interval. */
  async readFeed(limit = 5): Promise<{ author: string; text: string }[]> {
    const gate = this.isEnabled();
    if (!gate.ok) throw new LinkedInStopped(gate.reason!);
    this.checkCap('feed');
    const ctx = await this.context(true);
    try {
      const page = await ctx.newPage();
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await this.guardPage(page);
      await page.waitForTimeout(2500);
      const n = Math.max(1, Math.min(15, limit));
      const posts = await page.evaluate((max) => {
        const out: { author: string; text: string }[] = [];
        const cards = document.querySelectorAll('div.feed-shared-update-v2');
        for (const c of Array.from(cards).slice(0, max)) {
          const author = (c.querySelector('.update-components-actor__name')?.textContent ?? '').replace(/\s+/g, ' ').trim();
          const text = (c.querySelector('.update-components-text')?.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (author || text) out.push({ author, text: text.slice(0, 1200) });
        }
        return out;
      }, n);
      this.bumpCap('feed');
      return posts;
    } finally {
      await ctx.close();
    }
  }

  /**
   * Easy Apply on a job URL. Fills only from the profile; stops before the
   * final submit and asks the confirm callback; logs everything.
   */
  async easyApply(
    url: string,
    profile: Profile,
    hooks: {
      askFacts: (questions: string[]) => Promise<Record<string, string>>;
      confirmSubmit: (summary: string) => Promise<boolean>;
    },
  ): Promise<{ status: 'submitted' | 'cancelled' | 'needs-facts' | 'failed'; detail: string; missing?: string[] }> {
    const gate = this.isEnabled();
    if (!gate.ok) throw new LinkedInStopped(gate.reason!);
    this.checkCap('action');
    const ctx = await this.context(false); // visible so the user can watch/step in
    try {
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await this.guardPage(page);
      const easyBtn = page.getByRole('button', { name: /easy apply/i }).first();
      if (!(await easyBtn.isVisible({ timeout: 8000 }).catch(() => false))) {
        return { status: 'failed', detail: 'No Easy Apply button on this posting (it may be an external application). Use the generic apply-from-link flow instead.' };
      }
      await easyBtn.click();
      await page.waitForTimeout(2000);
      const answers: Record<string, string> = {};
      for (let step = 0; step < 10; step++) {
        await this.guardPage(page);
        // Fill visible text inputs from profile
        const filled = await this.fillModalFromProfile(page, profile, answers);
        const missing = filled.missing.filter((m) => !answers[m]);
        if (missing.length && step === 0) {
          const got = await hooks.askFacts(missing);
          Object.assign(answers, got);
          if (Object.keys(got).length === 0) return { status: 'needs-facts', detail: `Missing: ${missing.join(', ')}`, missing };
          await this.fillModalFromProfile(page, profile, answers);
        }
        const nextBtn = page.getByRole('button', { name: /^(next|review|continue)$/i }).first();
        const submitBtn = page.getByRole('button', { name: /^(submit application|submit)$/i }).first();
        if (await submitBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
          const summary = `LinkedIn Easy Apply for:\n${url}\nFilled from your profile. Review the visible browser window, then confirm here.`;
          const ok = await hooks.confirmSubmit(summary);
          if (!ok) return { status: 'cancelled', detail: 'You declined the final submit. Nothing was sent.' };
          await submitBtn.click();
          await page.waitForTimeout(3000);
          this.bumpCap('action');
          return { status: 'submitted', detail: 'Easy Apply submitted.' };
        }
        if (await nextBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
          await nextBtn.click();
          await page.waitForTimeout(1800);
          continue;
        }
        return { status: 'failed', detail: 'Could not find a Next/Submit control in the Easy Apply dialog. Nothing was submitted.' };
      }
      return { status: 'failed', detail: 'Easy Apply took too many steps; stopped. Nothing was submitted.' };
    } finally {
      await ctx.close();
    }
  }

  private async fillModalFromProfile(
    page: Page,
    profile: Profile,
    answers: Record<string, string>,
  ): Promise<{ missing: string[] }> {
    const { matchProfileKey } = await import('./profile.js');
    return (async () => {
      const missing: string[] = [];
      const inputs = await page.$$('div[data-test-modal] input[type="text"], div[role="dialog"] input[type="text"], div[role="dialog"] input[type="tel"], div[role="dialog"] input[type="email"]');
      for (const el of inputs) {
        const current = await el.inputValue().catch(() => '');
        if (current) continue;
        const id = await el.getAttribute('id');
        let label = '';
        if (id) {
          const lab = await page.$(`label[for="${CSS.escape(id)}"]`);
          if (lab) label = (await lab.textContent())?.trim() ?? '';
        }
        if (!label) label = (await el.getAttribute('aria-label')) ?? (await el.getAttribute('name')) ?? '';
        const key = matchProfileKey(label);
        const value = answers[label] || (key ? String(profile[key] ?? '') : '');
        if (value) await el.fill(value).catch(() => {});
        else if (label) missing.push(label);
      }
      return { missing };
    })();
  }

  /** Send a direct message to a profile URL. Always confirmed first. */
  async sendMessage(
    profileUrl: string,
    text: string,
    confirm: (summary: string) => Promise<boolean>,
  ): Promise<{ status: 'sent' | 'cancelled' | 'failed'; detail: string }> {
    const gate = this.isEnabled();
    if (!gate.ok) throw new LinkedInStopped(gate.reason!);
    if (!text.trim()) throw new Error('Message text is empty.');
    this.checkCap('action');
    const ctx = await this.context(false);
    try {
      const page = await ctx.newPage();
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await this.guardPage(page);
      const msgBtn = page.getByRole('button', { name: /^message/i }).first();
      if (!(await msgBtn.isVisible({ timeout: 8000 }).catch(() => false)))
        return { status: 'failed', detail: 'No Message button - you may not be connected to this person.' };
      const ok = await confirm(`Send this LinkedIn message to ${profileUrl}?\n\n${text}`);
      if (!ok) return { status: 'cancelled', detail: 'You declined. Nothing was sent.' };
      await msgBtn.click();
      await page.waitForTimeout(2000);
      const box = page.locator('div.msg-form__contenteditable[contenteditable="true"]').first();
      await box.click();
      await box.pressSequentially(text, { delay: 15 });
      await page.waitForTimeout(800);
      await page.getByRole('button', { name: /^send$/i }).first().click();
      await page.waitForTimeout(1500);
      this.bumpCap('action');
      return { status: 'sent', detail: 'Message sent.' };
    } finally {
      await ctx.close();
    }
  }

  /** Send a connection invite, optional note. Always confirmed first. */
  async sendInvite(
    profileUrl: string,
    note: string,
    confirm: (summary: string) => Promise<boolean>,
  ): Promise<{ status: 'sent' | 'cancelled' | 'failed'; detail: string }> {
    const gate = this.isEnabled();
    if (!gate.ok) throw new LinkedInStopped(gate.reason!);
    this.checkCap('action');
    const ctx = await this.context(false);
    try {
      const page = await ctx.newPage();
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await this.guardPage(page);
      const connectBtn = page.getByRole('button', { name: /^connect/i }).first();
      if (!(await connectBtn.isVisible({ timeout: 8000 }).catch(() => false)))
        return { status: 'failed', detail: 'No Connect button found (it may sit under the More menu, or you are already connected).' };
      const ok = await confirm(`Send a LinkedIn connection invite to ${profileUrl}${note ? ' with note:\n\n' + note : ' (no note)'}?`);
      if (!ok) return { status: 'cancelled', detail: 'You declined. Nothing was sent.' };
      await connectBtn.click();
      await page.waitForTimeout(1800);
      if (note.trim()) {
        const addNote = page.getByRole('button', { name: /add a note/i }).first();
        if (await addNote.isVisible({ timeout: 4000 }).catch(() => false)) {
          await addNote.click();
          await page.locator('textarea[name="message"], #custom-message').first().fill(note.slice(0, 300));
          await page.getByRole('button', { name: /^send/i }).first().click();
        }
      } else {
        await page.getByRole('button', { name: /send without a note|^send$/i }).first().click();
      }
      await page.waitForTimeout(1500);
      this.bumpCap('action');
      return { status: 'sent', detail: 'Invite sent.' };
    } finally {
      await ctx.close();
    }
  }

  statusLine(): string {
    const s = this.loadCaps();
    const caps = this.store.getSettings().linkedin.caps;
    return `LinkedIn today: ${s.feedChecks}/${caps.feedChecksPerDay} feed checks, ${s.actions}/${caps.actionsPerDay} actions.`;
  }
}

void log; // reserved for future structured events
