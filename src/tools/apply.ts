// Apply-from-link: opens a job posting in a real browser (Playwright),
// fills the application form strictly from the user's saved profile, asks
// for missing facts, and never submits without an explicit confirmation.
// Honest scope: generic single-page and Greenhouse/Lever-style forms.
// Complex multi-step builders may need the user to finish by hand - the
// agent says so instead of guessing.
import { chromium, type Browser, type Page } from 'playwright';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Profile } from './profile.js';
import { matchProfileKey, pickOption } from './profile.js';
import { log } from '../util/log.js';

export interface FilledField {
  label: string;
  profileKey: string;
  value: string;
}

export interface ApplyResult {
  status: 'needs-facts' | 'awaiting-confirm' | 'submitted' | 'failed' | 'cancelled';
  url: string;
  filled: FilledField[];
  missing: string[];
  summary: string;
  error?: string;
  screenshot?: string;
}

export interface ApplyHooks {
  /** Called with the unresolved questions; answers come back keyed by question text. */
  askFacts: (questions: string[]) => Promise<Record<string, string>>;
  /** Called with a human summary of what will be submitted; resolve true to submit. */
  confirmSubmit: (summary: string) => Promise<boolean>;
}

interface PageField {
  index: number;
  kind: 'text' | 'textarea' | 'select' | 'file' | 'checkbox' | 'radio';
  label: string;
  required: boolean;
  options: string[];
  filled: boolean;
  value: string;
}

export function logApplication(dir: string, entry: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'applications.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
}

export function readApplicationLog(dir: string, limit = 100): Record<string, unknown>[] {
  try {
    const lines = fsRead(join(dir, 'applications.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return { ts: '', status: 'unparseable' }; } });
  } catch {
    return [];
  }
}
import { readFileSync as fsRead } from 'node:fs';

const SUBMIT_RE = /^(apply|submit|send application|submit application|apply now|finish|done)$/i;
const APPLY_BUTTON_RE = /\b(apply|easy apply)\b/i;

async function enumerateFields(page: Page): Promise<PageField[]> {
  return page.evaluate(() => {
    const fields: PageField[] = [];
    const els = Array.from(document.querySelectorAll('input, select, textarea')) as (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[];
    let i = 0;
    for (const el of els) {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'password'].includes(type)) continue;
      if ((el as HTMLElement).offsetParent === null && type !== 'file') continue; // not visible
      let kind: PageField['kind'] = 'text';
      if (tag === 'select') kind = 'select';
      else if (tag === 'textarea') kind = 'textarea';
      else if (type === 'file') kind = 'file';
      else if (type === 'checkbox') kind = 'checkbox';
      else if (type === 'radio') kind = 'radio';
      else if (type === 'email' || type === 'tel' || type === 'url' || type === 'text' || type === 'number' || type === 'date') kind = 'text';
      else continue;
      const id = el.getAttribute('id');
      let label = '';
      if (id) {
        const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lab) label = lab.textContent?.trim() ?? '';
      }
      if (!label) {
        const wrap = el.closest('label');
        if (wrap) label = wrap.textContent?.trim() ?? '';
      }
      if (!label) label = el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? el.getAttribute('name') ?? '';
      const marker = `pa-field-${i}`;
      el.setAttribute('data-pa-field', marker);
      fields.push({
        index: i,
        kind,
        label: label.replace(/\s+/g, ' ').slice(0, 200),
        required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label),
        options: tag === 'select' ? Array.from((el as HTMLSelectElement).options).map((o) => o.text).filter((t) => t.trim() && !/select|choose/i.test(t)) : [],
        filled: Boolean((el as HTMLInputElement).value),
        value: (el as HTMLInputElement).value ?? '',
      });
      i++;
    }
    return fields as PageField[];
  });
}

async function fillField(page: Page, field: PageField, value: string): Promise<boolean> {
  const sel = `[data-pa-field="pa-field-${field.index}"]`;
  try {
    if (field.kind === 'select') {
      const chosen = pickOption(value, field.options);
      if (!chosen) return false;
      await page.selectOption(sel, { label: chosen });
    } else if (field.kind === 'file') {
      await page.setInputFiles(sel, value);
    } else if (field.kind === 'checkbox') {
      if (/^(yes|true|1|agree|i agree)$/i.test(value)) await page.check(sel);
    } else {
      await page.fill(sel, value);
    }
    return true;
  } catch (err) {
    log.warn(`Could not fill field "${field.label}":`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** Value used for a profile key; full-name fields combine first+last. */
function valueFor(profile: Profile, key: keyof Profile, label: string): string {
  if (key === 'firstName' && /full name|your name|^name$/i.test(label)) {
    return [profile.firstName, profile.lastName].filter(Boolean).join(' ');
  }
  const v = profile[key];
  return typeof v === 'string' ? v : '';
}

export async function runJobApplication(
  opts: { url: string; profile: Profile; headless?: boolean; dataDir?: string; keepOpenMs?: number },
  hooks: ApplyHooks,
): Promise<ApplyResult> {
  const dataDir = opts.dataDir ?? join(process.cwd(), 'data');
  const filled: FilledField[] = [];
  const extraAnswers: Record<string, string> = {};
  let browser: Browser | null = null;
  const result: ApplyResult = { status: 'failed', url: opts.url, filled, missing: [], summary: '' };

  try {
    browser = await chromium.launch({ headless: opts.headless ?? true });
    const page = await browser.newPage();
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    // If the posting has a separate Apply button leading to the form, click it once.
    const candidate = page.getByRole('button', { name: APPLY_BUTTON_RE }).first();
    const linkCandidate = page.getByRole('link', { name: APPLY_BUTTON_RE }).first();
    try {
      if (await candidate.isVisible({ timeout: 3000 })) await candidate.click();
      else if (await linkCandidate.isVisible({ timeout: 1500 })) await linkCandidate.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    } catch { /* no intermediate apply button - the form may already be on the page */ }

    for (let pass = 0; pass < 2; pass++) {
      const fields = await enumerateFields(page);
      const missing: string[] = [];
      for (const f of fields) {
        if (f.filled && f.kind !== 'file') continue; // pre-filled by the site
        const signals = [f.label].join(' ');
        const key = matchProfileKey(signals);
        let value = '';
        let profileKey = '';
        if (key) {
          value = pass === 1 && extraAnswers[f.label] ? extraAnswers[f.label] : valueFor(opts.profile, key, f.label);
          profileKey = key;
        }
        if (!value && extraAnswers[f.label]) {
          value = extraAnswers[f.label];
          profileKey = 'user-answer';
        }
        if (value) {
          const ok = await fillField(page, f, value);
          if (ok) filled.push({ label: f.label, profileKey, value: f.kind === 'file' ? '(resume file)' : value });
        } else if (f.required || pass === 1) {
          missing.push(f.label || `field ${f.index + 1}`);
        }
      }
      const unanswered = missing.filter((m) => !extraAnswers[m]);
      if (unanswered.length === 0 || pass === 1) {
        result.missing = pass === 1 ? missing.filter((m) => !extraAnswers[m]) : [];
        break;
      }
      const answers = await hooks.askFacts(unanswered);
      for (const [q, a] of Object.entries(answers)) if (a?.trim()) extraAnswers[q] = a.trim();
      if (Object.keys(answers).length === 0) {
        result.status = 'needs-facts';
        result.missing = unanswered;
        result.summary = `I need these facts before I can apply: ${unanswered.join(', ')}`;
        return result;
      }
    }

    const shot = join(dataDir, `apply-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    result.screenshot = shot;
    const summaryLines = filled.map((f) => `- ${f.label}: ${f.value}`);
    result.summary = `Ready to apply at ${opts.url}\nFilled:\n${summaryLines.join('\n') || '(nothing)'}` +
      (result.missing.length ? `\nLeft empty (no fact available): ${result.missing.join(', ')}` : '');

    const ok = await hooks.confirmSubmit(result.summary);
    if (!ok) {
      result.status = 'cancelled';
      logApplication(dataDir, { url: opts.url, status: 'cancelled', filled: filled.map((f) => f.label) });
      return result;
    }

    const submit = page.locator('button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Apply")').first();
    await submit.click({ timeout: 10_000 });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(3000);
    result.status = 'submitted';
    logApplication(dataDir, { url: opts.url, status: 'submitted', filled: filled.map((f) => f.label), missing: result.missing });
    return result;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    logApplication(dataDir, { url: opts.url, status: 'failed', error: result.error });
    return result;
  } finally {
    await browser?.close().catch(() => {});
  }
}
