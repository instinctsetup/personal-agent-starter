/** "fill form <url>": read every question on a web form (Google Forms structure or generic HTML),
 *  fill true answers from the profile + durable memory, ask in chat for unknowns,
 *  gate the submit behind a review card, submit, and capture the confirmation.
 *  Never invents facts: unknown answers come from the user, or the field stays empty. */
import { ensureBrowser, navigate, screenshot } from "./browser.js";
import { listMemories } from "./memory.js";

export type FormQuestion = {
  id: string;
  label: string;
  type: "text" | "paragraph" | "radio" | "checkbox" | "dropdown" | "file" | "unknown";
  options: string[];
  required: boolean;
};

export type FillResult = {
  status: "submitted" | "cancelled" | "blocked" | "failed";
  pages: number;
  answered: Record<string, string>;
  unknowns: string[];
  screenshot?: Buffer;
  error?: string;
};

export type FormHooks = {
  say: (text: string) => void;
  askFacts: (qs: string[]) => Promise<Record<string, string> | null>;
  confirm: (summary: string, answers: Record<string, string>) => Promise<boolean>;
};

/** Runs in the page: tag every interactive element with data-pa-q / data-pa-idx and describe the questions. */
const EXTRACT_JS = `(() => {
  // multi-page forms keep prior pages in the DOM (hidden) - drop last extraction's tags or selectors collide
  [...document.querySelectorAll("[data-pa-q],[data-pa-next],[data-pa-submit]")].forEach((e) => {
    e.removeAttribute("data-pa-q"); e.removeAttribute("data-pa-idx"); e.removeAttribute("data-pa-next"); e.removeAttribute("data-pa-submit");
  });
  const tag = (el, qid, idx) => { el.setAttribute("data-pa-q", qid); if (idx !== undefined) el.setAttribute("data-pa-idx", String(idx)); };
  const txt = (el) => (el.innerText || el.textContent || "").trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const qs = [];
  const items = [...document.querySelectorAll('div[role="listitem"]')].filter(vis);
  if (items.length) {
    items.forEach((item, qi) => {
      const qid = "q" + qi;
      const head = item.querySelector('[role="heading"]') || item;
      const headText = txt(head);
      const label = headText.replace(/\\s*\\*\\s*$/, "").trim();
      const required = /\\*\\s*$/.test(headText) || !!item.querySelector('[aria-required="true"]');
      const file = item.querySelector('input[type="file"]');
      const radios = [...item.querySelectorAll('[role="radio"]')];
      const checks = [...item.querySelectorAll('[role="checkbox"]')];
      const listbox = item.querySelector('[role="listbox"]');
      const ta = item.querySelector("textarea");
      const inp = item.querySelector('input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input[type="date"], input:not([type])');
      if (file) { tag(file, qid); qs.push({ id: qid, label, type: "file", options: [], required }); }
      else if (radios.length) { radios.forEach((r, i) => tag(r, qid, i)); qs.push({ id: qid, label, type: "radio", options: radios.map((r) => (r.getAttribute("aria-label") || txt(r)).trim()), required }); }
      else if (checks.length) { checks.forEach((r, i) => tag(r, qid, i)); qs.push({ id: qid, label, type: "checkbox", options: checks.map((r) => (r.getAttribute("aria-label") || txt(r)).trim()), required }); }
      else if (listbox) { tag(listbox, qid); qs.push({ id: qid, label, type: "dropdown", options: [...listbox.querySelectorAll('[role="option"]')].map((o) => txt(o)).filter(Boolean), required }); }
      else if (ta) { tag(ta, qid); qs.push({ id: qid, label, type: "paragraph", options: [], required }); }
      else if (inp) { tag(inp, qid); qs.push({ id: qid, label, type: "text", options: [], required }); }
      else qs.push({ id: qid, label, type: "unknown", options: [], required });
    });
  } else {
    const groups = new Map();
    const fields = [...document.querySelectorAll("input, textarea, select")].filter(vis).filter((el) => !["hidden", "submit", "button", "image", "reset", "password"].includes((el.getAttribute("type") || "").toLowerCase()));
    let n = 0;
    const labelOf = (el) => {
      if (el.id) { const l = document.querySelector('label[for="' + el.id + '"]'); if (l) return txt(l); }
      const wrap = el.closest("label"); if (wrap) return txt(wrap);
      return (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || "field").trim();
    };
    for (const el of fields) {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      const label = labelOf(el).replace(/\\s*\\*\\s*$/, "").trim();
      const required = el.required || el.getAttribute("aria-required") === "true" || /\\*\\s*$/.test(labelOf(el));
      if (type === "radio" || type === "checkbox") {
        const name = el.getAttribute("name") || label;
        if (!groups.has(name)) {
          groups.set(name, "q" + n++);
          const siblings = [...document.querySelectorAll('input[name="' + CSS.escape(name) + '"]')];
          siblings.forEach((s, i) => tag(s, groups.get(name), i));
          qs.push({ id: groups.get(name), label: type === "radio" ? label : label, type, options: siblings.map((s) => labelOf(s)), required });
        }
        continue;
      }
      const qid = "q" + n++;
      tag(el, qid);
      qs.push({ id: qid, label, type: el.tagName === "SELECT" ? "dropdown" : el.tagName === "TEXTAREA" ? "paragraph" : type === "file" ? "file" : "text", options: el.tagName === "SELECT" ? [...el.querySelectorAll("option")].map((o) => txt(o)).filter((o) => o && !/^choose|select/i.test(o)) : [], required });
    }
  }
  const buttons = [...document.querySelectorAll('div[role="button"], button, input[type="submit"]')].filter(vis);
  const btext = (b) => (b.innerText || b.value || "").trim().toLowerCase();
  const hasNext = buttons.some((b) => /^(next|continue)$/i.test(btext(b)));
  const hasSubmit = buttons.some((b) => /^(submit|send|submit form)$/i.test(btext(b)));
  for (const b of buttons) { if (/^(next|continue)$/i.test(btext(b))) b.setAttribute("data-pa-next", "1"); if (/^(submit|send|submit form)$/i.test(btext(b))) b.setAttribute("data-pa-submit", "1"); }
  return { questions: qs, hasNext, hasSubmit };
})()`;

/** Profile/memory facts -> an answer for a question label. Empty string = unknown. */
const FACT_MAP: [RegExp, string][] = [
  [/\b(first|given)\s*name\b/i, "firstName"],
  [/\b(last|sur|family)\s*name\b/i, "lastName"],
  [/\b(full|your)\s*name\b|^name$/i, "__fullName"],
  [/e-?mail/i, "email"],
  [/phone|mobile|contact\s*(number|no)/i, "phone"],
  [/university|college|institut/i, "university"],
  [/graduation|passing\s*year|class of/i, "graduationYear"],
  [/degree|education|qualification|course|branch|major/i, "education"],
  [/linkedin/i, "linkedin"],
  [/github/i, "github"],
  [/portfolio|website|personal\s*(site|page)/i, "portfolio"],
  [/city|location|where (do you|are you)/i, "location"],
  [/address/i, "address"],
  [/current\s*(company|employer|organization|organisation)/i, "currentCompany"],
  [/current\s*(title|role|position)|designation/i, "currentTitle"],
  [/years?\s*(of)?\s*experience/i, "yearsExperience"],
  [/salary|ctc|compensation|stipend/i, "salaryExpectation"],
  [/notice\s*period/i, "noticePeriod"],
  [/pronouns/i, "pronouns"],
  [/work\s*authori[sz]ation|visa|eligible to work/i, "workAuthorization"],
];

export function answerFromFacts(label: string, type: FormQuestion["type"], profile: Record<string, string>): string {
  if (type === "file") return /resume|cv\b|curriculum/i.test(label) ? profile.resumePath || "" : profile.resumePath || "";
  for (const [re, key] of FACT_MAP) {
    if (re.test(label)) {
      if (key === "__fullName") return `${profile.firstName || ""} ${profile.lastName || ""}`.trim();
      return profile[key] || "";
    }
  }
  // durable memories: find a memory mentioning the label's distinctive words
  const words = label.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w.length > 4);
  if (words.length) {
    for (const m of listMemories(50)) {
      const t = m.text.toLowerCase();
      if (words.some((w) => t.includes(w))) return m.text;
    }
  }
  return "";
}

/** Pick the option index matching a free-text answer. -1 = no match. */
export function matchOption(options: string[], answer: string): number {
  const a = answer.trim().toLowerCase();
  if (!a) return -1;
  let i = options.findIndex((o) => o.trim().toLowerCase() === a);
  if (i >= 0) return i;
  i = options.findIndex((o) => o.trim().toLowerCase().startsWith(a) || a.startsWith(o.trim().toLowerCase()));
  if (i >= 0) return i;
  return options.findIndex((o) => o.trim().toLowerCase().includes(a) || a.includes(o.trim().toLowerCase()));
}

async function fillQuestion(page: any, q: FormQuestion, answer: string): Promise<boolean> {
  const sel = `[data-pa-q="${q.id}"]`;
  try {
    if (q.type === "text" || q.type === "paragraph") {
      await page.locator(sel).first().fill(answer);
      return true;
    }
    if (q.type === "file") {
      if (!answer) return false;
      await page.locator(sel).first().setInputFiles(answer);
      return true;
    }
    if (q.type === "radio") {
      const i = matchOption(q.options, answer);
      if (i < 0) return false;
      await page.locator(`[data-pa-q="${q.id}"][data-pa-idx="${i}"]`).first().click();
      return true;
    }
    if (q.type === "checkbox") {
      let any = false;
      for (const part of answer.split(/[,;]+/).map((s: string) => s.trim()).filter(Boolean)) {
        const i = matchOption(q.options, part);
        if (i >= 0) { await page.locator(`[data-pa-q="${q.id}"][data-pa-idx="${i}"]`).first().click(); any = true; }
      }
      return any;
    }
    if (q.type === "dropdown") {
      const el = page.locator(sel).first();
      const tag = await el.evaluate((e: any) => e.tagName).catch(() => "");
      if (tag === "SELECT") {
        const i = matchOption(q.options, answer);
        if (i < 0) return false;
        await el.selectOption({ label: q.options[i] });
        return true;
      }
      // Google-style listbox: open, then click the matching option
      await el.click();
      await page.waitForTimeout(400);
      const i = matchOption(q.options, answer);
      if (i < 0) { await page.keyboard.press("Escape"); return false; }
      const target = q.options[i];
      await page.locator('[role="option"]', { hasText: target }).first().click();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

const CONFIRM_RE = /response has been recorded|thank you|thanks for (your|filling)|submission (received|complete)|form submitted|submitted successfully/i;

export async function runFormFill(opts: { url: string; profile: Record<string, any>; resumePath?: string }, hooks: FormHooks): Promise<FillResult> {
  const answered: Record<string, string> = {};
  const unknowns: string[] = [];
  try {
    const finalUrl = await navigate(opts.url);
    if (/accounts\.google\.com|accounts\.youtube\.com/.test(finalUrl)) {
      return { status: "blocked", pages: 0, answered, unknowns, error: "This form needs a Google sign-in. Take over in the Browser tab, sign in, then say `fill form <url>` again." };
    }
    const page = await ensureBrowser();
    let pages = 1;
    for (let guard = 0; guard < 10; guard++) {
      const { questions, hasNext, hasSubmit } = await page.evaluate(EXTRACT_JS) as { questions: FormQuestion[]; hasNext: boolean; hasSubmit: boolean };
      if (!questions.length) return { status: "failed", pages, answered, unknowns, error: "No questions found on this page - it may not be a form, or it is behind a login." };

      // map answers: profile facts + memory first, then ask the user for the rest
      const toAsk: string[] = [];
      const pageAnswers: Record<string, string> = {};
      for (const q of questions) {
        let ans = answerFromFacts(q.label, q.type, opts.profile as Record<string, string>);
        if (q.type === "file" && opts.resumePath && !ans) ans = opts.resumePath;
        if (!ans && q.type !== "file" && q.type !== "unknown") toAsk.push(q.label);
        else pageAnswers[q.label] = ans;
      }
      if (toAsk.length) {
        hooks.say(`Page ${pages}: I need ${toAsk.length} answer(s) I don't have:`);
        const got = await hooks.askFacts(toAsk);
        for (const label of toAsk) {
          if (got?.[label]) pageAnswers[label] = got[label];
          else unknowns.push(label);
        }
      }

      // fill everything we have
      for (const q of questions) {
        const ans = pageAnswers[q.label];
        if (!ans) continue;
        if (q.type !== "file" || ans) {
          const ok = await fillQuestion(page, q, ans);
          if (ok) answered[q.label] = q.type === "file" ? ans.split(/[\\/]/).pop() || ans : ans;
          else if (q.required) unknowns.push(`${q.label} (couldn't set "${ans}" - no matching option)`);
        }
      }

      if (hasNext && guard < 9) {
        await page.locator('[data-pa-next="1"]').first().click();
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await page.waitForTimeout(700);
        pages++;
        continue;
      }
      if (hasSubmit) {
        const summary = [`Review before I submit (page ${pages} of ${pages}):`]
          .concat(Object.entries(answered).map(([k, v]) => `- ${k}: ${v}`))
          .concat(unknowns.length ? ["", `Left empty/unanswered: ${unknowns.join(", ")}`] : [])
          .join("\n");
        const go = await hooks.confirm(summary, answered);
        if (!go) return { status: "cancelled", pages, answered, unknowns };
        await page.locator('[data-pa-submit="1"]').first().click();
        await page.waitForTimeout(1200);
        // confirmation: text match, or the submit button is simply gone after a nav
        const body = await page.evaluate("document.body ? document.body.innerText.slice(0, 3000) : ''").catch(() => "");
        const stillThere = await page.locator('[data-pa-submit="1"]').count().catch(() => 0);
        const confirmed = CONFIRM_RE.test(String(body)) || stillThere === 0;
        const shot = await screenshot().catch(() => undefined);
        if (!confirmed) {
          return { status: "failed", pages, answered, unknowns, screenshot: shot, error: "Clicked submit but saw no confirmation - check the Browser tab; the form may have rejected a required answer." };
        }
        return { status: "submitted", pages, answered, unknowns, screenshot: shot };
      }
      return { status: "failed", pages, answered, unknowns, error: "Found neither a Next nor a Submit button - can't proceed safely." };
    }
    return { status: "failed", pages, answered, unknowns, error: "Too many pages (>10) - stopped for safety." };
  } catch (e: any) {
    return { status: "failed", pages: 1, answered, unknowns, error: String(e?.message || e) };
  }
}
