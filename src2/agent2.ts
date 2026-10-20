/** v2 chat orchestration: command -> streamed events -> tools -> approvals. */
import { db } from "./db.js";
import { emit, newRunId, onEvent, type AgentEvent } from "./bus.js";
import { requestApproval, waitApproval } from "./approvals.js";
import { checkCap, recordAction, capStatus, setCap, DEFAULT_CAPS } from "./caps.js";
import { createPlan, getPlan, listPlans, cancelPlan, runPlan, type Plan } from "./plans.js";
import { webSearch } from "./search.js";
import { addApplication, listApplications } from "./tracker.js";
import { listCredentials, saveCredential, getCredential } from "./vault.js";
import { getSetting, setSetting, DATA_DIR } from "./db.js";
import { parseSchedule } from "./scheduler.js";
import { MockProvider } from "../src/providers/mock.js";

import { OpenAiCompatibleProvider } from "../src/providers/openai.js";
import { GeminiProvider, GeminiError } from "../src/providers/gemini.js";
import { geminiWebEnabled, geminiWebChat, flattenMessages } from "./geminiweb.js";
import { routeWithModel } from "./router.js";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash"; // most capable model on the free tier (verified against ai.google.dev/gemini-api/docs/pricing, Oct 2026)
export const FALLBACK_GEMINI_MODEL = "gemini-2.5-flash"; // stable free-tier fallback if the default is not found
/** Free-tier models tried in order when the configured one is overloaded (503/429). Verified against ai.google.dev/gemini-api/docs/rate-limits, Oct 2026. */
export const GEMINI_FALLBACK_CHAIN = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash"];
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

function provider() {
  const key = getSetting("model_api_key");
  const kind = getSetting("model_provider") || "openai";
  if (kind === "gemini") {
    const model = getSetting("model") || DEFAULT_GEMINI_MODEL;
    return key ? new GeminiProvider(model, key, process.env.GEMINI_BASE_URL || undefined) : new MockProvider();
  }
  const base = getSetting("model_base_url") || "https://api.openai.com/v1";
  const model = getSetting("model") || DEFAULT_OPENAI_MODEL;
  return key ? new OpenAiCompatibleProvider(base, model, key) : new MockProvider();
}

function say(runId: string, text: string, extra: Partial<AgentEvent> = {}) {
  emit({ ts: Date.now(), run_id: runId, kind: "text", role: "agent", text, ...extra });
}

async function toolCall<T>(runId: string, tool: string, input: unknown, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  emit({ ts: started, run_id: runId, kind: "tool_call", tool, input, state: "running" });
  try {
    const result = await fn();
    emit({ ts: Date.now(), run_id: runId, kind: "tool_result", tool, input, result, duration_ms: Date.now() - started, state: "ok" });
    return result;
  } catch (err: any) {
    emit({ ts: Date.now(), run_id: runId, kind: "tool_result", tool, input, error: String(err?.message || err), duration_ms: Date.now() - started, state: "error" });
    throw err;
  }
}

/** Hard cap on how long one chat turn may wait for the model before a visible failure message is shown. */
export const CHAT_DEADLINE_MS = Number(process.env.AGENT_CHAT_DEADLINE_MS) || 100_000;
const STATUS_TICK_MS = Number(process.env.AGENT_STATUS_TICK_MS) || 3_000;

/** Run a slow step with a live "waiting ... Ns" status and a hard deadline, so the UI never sits silent. */
export async function withProgress<T>(runId: string, label: string, fn: () => Promise<T>, deadlineMs = CHAT_DEADLINE_MS): Promise<T> {
  const started = Date.now();
  const tick = () => emit({ ts: Date.now(), run_id: runId, kind: "status", state: "waiting", label, elapsed_s: Math.round((Date.now() - started) / 1000), text: `${label}... ${Math.round((Date.now() - started) / 1000)}s` }, false);
  tick();
  const interval = setInterval(tick, STATUS_TICK_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} took longer than ${Math.round(deadlineMs / 1000)}s, so I stopped waiting. Try again, or switch to a faster model (\`connect gemini\`, model gemini-2.5-flash).`)), deadlineMs);
  });
  try {
    return await Promise.race([fn(), deadline]);
  } finally {
    clearInterval(interval);
    clearTimeout(timer);
    emit({ ts: Date.now(), run_id: runId, kind: "status", state: "done", label, elapsed_s: Math.round((Date.now() - started) / 1000) }, false);
  }
}


const ADDR_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Detect "send/write/compose ... to <address>" phrased any way, without catching inbox questions. */
export function parseSendIntent(t: string): { to: string; from?: string; explicitBody?: string } | null {
  const lower = t.trim().toLowerCase();
  // read-ish openings are inbox questions, never sends
  if (/^(?:check|read|show|see|any|list|did|has|have|what|whats|what's|do i|are there)\b/.test(lower)) return null;
  const sendish = /\b(send|write|compose|draft|shoot|drop|forward|reply)\b/i.test(t) || /\b(?:e-?)?mail to\b/i.test(t) || /\bemail to\b/i.test(t);
  if (!sendish) return null;
  const mFrom = t.match(/\bfrom\s+([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i);
  const from = mFrom?.[1];
  const addrs = t.match(ADDR_RE) || [];
  const to = addrs.find((a) => a.toLowerCase() !== from?.toLowerCase());
  if (!to) return null;
  const esc = to.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mBody = t.match(new RegExp(`to\\s+${esc}\\s*:\\s*([\\s\\S]+)$`, "i"));
  return { to, from, explicitBody: mBody?.[1]?.trim() || undefined };
}

async function profileSenderName(): Promise<string> {
  try {
    const { ProfileStore } = await import("../src/tools/profile.js");
    const prof: any = new ProfileStore(DATA_DIR).get();
    return [prof?.firstName, prof?.lastName].filter(Boolean).join(" ");
  } catch { return ""; }
}

/** Model-drafted subject + body from the user's plain-English request. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Cap on parallel racers: each chat turn spends up to this many free-tier requests (the rate-limit tradeoff of racing). */
const RACE_MAX_RACERS = Number(process.env.MODEL_RACE_MAX) || 4;
/** Pause before a second race round when every racer failed in round one. */
const RACE_BACKOFF_MS = Number(process.env.MODEL_RACE_BACKOFF_MS) || 8_000;
const RACE_ROUNDS = 2;

import type { ChatMessage } from "../src/providers/types.js";

interface Racer { label: string; run: (signal: AbortSignal) => Promise<string>; }

/** Every free model the user can answer with right now: the Gemini free-tier chain on his key, plus optional Groq / OpenRouter free keys he added himself. */
export function buildRacers(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number }, includeWeb = false): Racer[] {
  const racers: Racer[] = [];
  const kind = getSetting("model_provider") || "openai";
  let configured = "";
  let geminiRest: Racer[] = [];
  if (kind === "gemini") {
    const key = getSetting("model_api_key") || "";
    if (key) {
      configured = getSetting("model") || DEFAULT_GEMINI_MODEL;
      const mk = (m: string): Racer => ({
        label: m,
        run: (signal) => new GeminiProvider(m, key, process.env.GEMINI_BASE_URL || undefined, { signal }).chat(messages, opts),
      });
      racers.push(mk(configured));
      geminiRest = GEMINI_FALLBACK_CHAIN.filter((x) => x !== configured).map(mk);
    }
  } else {
    configured = getSetting("model") || DEFAULT_OPENAI_MODEL;
    racers.push({ label: configured, run: () => provider().chat(messages, opts) });
  }
  // extra providers outrank the gemini chain tail, so a capped race still spans providers
  const groqKey = getSetting("groq_api_key");
  if (groqKey) {
    racers.push({
      label: "groq/llama-3.3-70b",
      run: (signal) => new OpenAiCompatibleProvider(process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile", groqKey, signal).chat(messages, opts),
    });
  }
  const orKey = getSetting("openrouter_api_key");
  if (orKey) {
    racers.push({
      label: "openrouter/llama-3.3-70b:free",
      run: (signal) => new OpenAiCompatibleProvider(process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1", "meta-llama/llama-3.3-70b-instruct:free", orKey, signal).chat(messages, opts),
    });
  }
  const all = racers.concat(geminiRest);
  if (includeWeb && geminiWebEnabled()) {
    // experimental last resort: the shared browser drives gemini.google.com with the user's own login
    all.push({ label: "gemini-web (experimental)", run: (signal) => geminiWebChat(flattenMessages(messages), signal) });
  }
  return all;
}

/**
 * Race the free models: fire the prompt at all of them in parallel, take the
 * first good answer, abort the slower calls, and say which model won. If every
 * racer fails (e.g. all of Google is 503ing), wait a beat and race once more.
 */
export async function modelRace(runId: string, messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number }, quiet = false): Promise<string> {
  const racers = buildRacers(messages, opts).slice(0, RACE_MAX_RACERS); // web provider joins round 2 only - see loop below
  if (racers.length === 0) return provider().chat(messages, opts); // offline/mock path
  if (racers.length === 1) return racers[0].run(new AbortController().signal);

  let lastErr: unknown;
  for (let round = 1; round <= RACE_ROUNDS; round++) {
    const roundRacers = round === 1 ? racers : buildRacers(messages, opts, true).slice(0, RACE_MAX_RACERS + 1);
    const controller = new AbortController();
    const result = await new Promise<{ text: string; label: string } | null>((resolve) => {
      let pending = roundRacers.length;
      let settled = false;
      for (const r of roundRacers) {
        r.run(controller.signal).then((text) => {
          if (settled) return;
          if (text?.trim()) {
            settled = true;
            controller.abort(); // cancel the slower calls
            resolve({ text, label: r.label });
            return;
          }
          if (--pending === 0) resolve(null);
        }).catch((err) => {
          lastErr = err;
          if (settled) return;
          if (--pending === 0) resolve(null);
        });
      }
    });
    if (result) {
      if (!quiet) say(runId, `Raced ${roundRacers.length} free models in parallel - ${result.label} answered first.`);
      return result.text;
    }
    if (round < RACE_ROUNDS) await sleep(RACE_BACKOFF_MS);
  }
  throw lastErr instanceof Error ? lastErr : new Error("All free models failed.");
}

async function draftWithModel(draftRunId: string, _p: ReturnType<typeof provider>, request: string, to: string, senderName: string): Promise<{ subject: string; body: string }> {
  const system = [
    "You draft emails for the user. Write in first person, as the user.",
    "Style: short (under 120 words), polite, direct, plain text. Match the user's casual but respectful tone.",
    "Never invent facts: use only what the request and the sender info below state. No fake achievements, companies, or names.",
    "If the request is a referral ask, write a short, specific referral request.",
    "Use a single [bracketed placeholder] only for a detail that is required and unknown.",
    senderName ? `Sign off as ${senderName}.` : "No sender name is known - skip the signature name.",
    "Reply in exactly this format:",
    "Subject: <one line>",
    "",
    "<body paragraphs>",
  ].join("\n");
  const raw = await modelRace(draftRunId, [
    { role: "system", content: system },
    { role: "user", content: `Recipient: ${to}\nSender name: ${senderName || "unknown"}\nThe user's request (their words): ${request}` },
  ], { maxTokens: 700 });
  const m = raw.match(/subject:\s*(.+)/i);
  if (!m) return { subject: "(no subject)", body: raw.trim() || "(empty draft - edit me)" };
  const body = raw.slice(raw.indexOf(m[0]) + m[0].length).replace(/^\s*\n/, "").trim();
  return { subject: m[1].trim().slice(0, 140) || "(no subject)", body: body || "(empty draft - edit me)" };
}

/** No-model fallback: an honest plain draft from the user's own words, meant to be edited in the card. */
export function fallbackDraft(request: string, _to: string, senderName = ""): { subject: string; body: string } {
  const ask = request
    .replace(/^\s*(?:can u|can you|could you|please|pls|hey|hi)\b/i, "")
    .replace(/\b(?:send|write|compose|draft|shoot|drop)\b[\s\S]{0,40}?\b(?:an?\s+)?(?:e-?)?mail\b/i, "")
    .replace(/\bto\s+[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const referral = /refer/i.test(request);
  const subject = referral ? "Referral request" : "Quick note";
  const cleaned = ask.replace(/^(?:asking|to ask)\s+for\s+/i, "").trim();
  const extra = cleaned && !/^(a\s+)?refer(r)?al(s)?( for (me|a job|an? \w+))?\.?$/i.test(cleaned) ? ` - ${cleaned}` : "";
  const line = referral
    ? `I wanted to ask if you could refer me${extra}.`
    : cleaned || request;
  return { subject, body: `Hi,\n\n${line}\n\nThanks,${senderName ? `\n${senderName}` : ""}` };
}


/** Strip chat-filler openers so "can u apply to ..." matches the same commands as "apply to ...". */
export function normalizeCommand(t: string): string {
  let s = t.trim();
  let prev = "";
  while (prev !== s) {
    prev = s;
    s = s.replace(/^(?:can u|can you|could you|would you|will you|please|pls|plz|hey|yo|bro|bhai|ok|okay|so|now|just)\b[\s,]*/i, "");
  }
  return s.trim();
}

/** One pending "the form needs these facts" question set from the applier; the next chat message answers it. */
let pendingFacts: { questions: string[]; resolve: (a: Record<string, string> | null) => void; timer: ReturnType<typeof setTimeout> } | null = null;

/** A hunt shortlist: the next "apply to 1,3" / "apply all" picks from it (15 min expiry). */
let pendingHunt: { results: import("./search.js").SearchResult[]; expires: number } | null = null;
let pendingClarify: { question: string; original: string; expires: number } | null = null;


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

/** LinkedInTools bound to the shared data dir, with the v2 risk-gate mirrored into its store. */
async function linkedinTools() {
  const { LinkedInTools } = await import("../src/tools/linkedin.js");
  const { Store } = await import("../src/config.js");
  const store = new Store(DATA_DIR);
  store.saveSettings({ linkedin: { enabled: true, riskAccepted: true } } as any);
  return new LinkedInTools(store, DATA_DIR);
}

/** The apply flow for one posting: fill profile facts, ask missing ones in chat, approval card before submit. */
async function runApplyFlow(runId: string, url: string): Promise<void> {
  const cap = checkCap("apply");
  if (!cap.allowed) {
    emit({ ts: Date.now(), run_id: runId, kind: "status", state: "denied", label: "apply", text: "apply denied: daily cap reached" });
    say(runId, `Daily application cap reached (${cap.used}/${cap.cap}). I won't start another one today - say \`cap apply <N>\` to raise it.`);
    return;
  }
  say(runId, `Starting the application flow for ${url}. I'll fill only profile facts, then show you an approval card before anything is submitted. Watch the Browser tab if you want.`);
  const result = await toolCall(runId, "jobs.apply", { url }, async () => {
    const { runJobApplication } = await import("../src/tools/apply.js");
    const { ProfileStore } = await import("../src/tools/profile.js");
    const profile = new ProfileStore(DATA_DIR).get();
    return runJobApplication({ url, profile, headless: true, dataDir: DATA_DIR }, {
      askFacts: async (qs: string[]) => {
        if (pendingFacts) return {}; // another apply is already asking - do not stack questions
        say(runId, [
          `The form needs ${qs.length} fact(s) I don't have:`,
          ...qs.map((q, i) => `${i + 1}. ${q}`),
          "",
          "Reply with the answers (one per line, same order), or `skip` to leave them empty. I never invent facts for you.",
        ].join("\n"));
        const answers = await new Promise<Record<string, string> | null>((resolve) => {
          const timer = setTimeout(() => {
            if (pendingFacts?.resolve === resolve) { pendingFacts = null; resolve(null); }
          }, 10 * 60 * 1000);
          pendingFacts = { questions: qs, resolve, timer };
        });
        if (answers === null) say(runId, "Skipped those - leaving the unknown fields empty.");
        return answers ?? {};
      },
      confirmSubmit: async (summary: string) => {
        const card = requestApproval("submit_application", summary, { url }, runId);
        say(runId, "Review the application summary above - Approve submits, Reject cancels.", { approval_id: card.id });
        const res = await waitApproval(card.id);
        return res.status === "approved";
      },
    });
  });
  if (result.status === "submitted") {
    recordAction("apply", url);
    addApplication({ company: new URL(url).hostname, role: "", portal: new URL(url).hostname, url, status: "Applied" });
    say(runId, `Submitted. Filled ${result.filled.length} field(s). Tracked in Jobs & Tracker.`);
  } else {
    emit({ ts: Date.now(), run_id: runId, kind: "status", state: "denied", label: "apply", text: `apply not submitted (${result.status})` });
    say(runId, `Not submitted (${result.status}). ${result.missing.length ? `Missing facts: ${result.missing.join(", ")}. Update with \`connect profile\`.` : result.summary || ""}`);
  }
}

export async function handleUserMessage(text: string, routed = false): Promise<void> {
  const runId = newRunId();
  emit({ ts: Date.now(), run_id: runId, kind: "text", role: "user", text });
  const t = text.trim();
  const cmd = normalizeCommand(t);
  const lower = cmd.toLowerCase();

  /** A hunt shortlist waiting for the user's picks. */
  // (declared below; selection handled before command routing)

  // an apply flow is waiting for missing facts - this message is the answer, not a new command
  if (pendingFacts) {
    const p = pendingFacts;
    pendingFacts = null;
    clearTimeout(p.timer);
    if (/^(skip|cancel|never\s?mind|stop)$/i.test(cmd)) {
      p.resolve(null);
    } else {
      const lines = t.split(/\n+/).map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^\d+[.)]\s*/, ""));
      const answers: Record<string, string> = {};
      if (p.questions.length === 1) {
        answers[p.questions[0]] = lines.join("\n");
      } else {
        p.questions.forEach((q, i) => { if (lines[i]) answers[q] = lines[i]; });
      }
      p.resolve(answers);
    }
    return;
  }

  // a hunt shortlist is open - "apply to 1,3" / "apply all" picks from it
  if (pendingHunt) {
    if (Date.now() > pendingHunt.expires) {
      pendingHunt = null;
    } else {
      const sel = cmd.match(/^(?:apply(?:\s+to)?\s+)?(all|\d+(?:\s*[, ]\s*\d+)*)$/i);
      if (sel) {
        const results = pendingHunt.results;
        pendingHunt = null;
        const picks = sel[1].toLowerCase() === "all"
          ? results
          : [...new Set(sel[1].split(/[\s,]+/).filter(Boolean).map(Number))].filter((n) => n >= 1 && n <= results.length).map((n) => results[n - 1]);
        if (!picks.length) {
          say(runId, "None of those numbers are on the shortlist. Run the hunt again and pick from the list.");
          return;
        }
        say(runId, `Applying to ${picks.length} posting(s), one at a time. Each still needs your approval before anything is submitted.`);
        for (const r of picks) await runApplyFlow(runId, r.url);
        return;
      }
      // not a selection: keep the shortlist open and route normally
    }
  }

  // an LLM-router clarify question is open - this message answers it
  if (pendingClarify) {
    if (Date.now() > pendingClarify.expires || /^(skip|cancel|never\s?mind|stop)$/i.test(cmd)) {
      pendingClarify = null;
      if (/^(skip|cancel|never\s?mind|stop)$/i.test(cmd)) { say(runId, "Cancelled."); return; }
    } else {
      const answered = pendingClarify;
      pendingClarify = null;
      text = `${answered.original}. Answer to the question "${answered.question}": ${t}`;
    }
  }

    const planExecutor = async (cmd: string): Promise<{ ok: boolean; error?: string; permanent?: boolean }> => {
      const start = Date.now();
      const fails: string[] = [];
      let denied = false; // a denial (user rejected, approval expired, cap) is a permanent failure: retrying would fight the user's "no"
      const off = onEvent((e) => {
        if (e.ts < start) return;
        if (e.kind === "error") fails.push(String(e.text || e.label || "step error"));
        if (e.kind === "status" && (e as any).state === "denied") { denied = true; fails.push(String(e.text || "denied")); }
      });
      try {
        await handleUserMessage(cmd, true);
      } catch (e: any) {
        off();
        return { ok: false, error: String(e?.message || e) };
      }
      off();
      return fails.length ? { ok: false, error: fails[0], permanent: denied } : { ok: true };
    };
    const planFixer = async (goal: string, step: { cmd: string; error?: string }): Promise<string | null> => {
      if (provider().offline) return null;
      const re = await routeWithModel(
        `I tried "${step.cmd}" but it failed: ${step.error || "unknown error"}. Give me ONE different command that still makes progress on this goal: ${goal}`,
        (msgs) => withProgress(runId, "Re-planning a failed step", () => modelRace(runId, msgs, undefined, true), Math.min(15_000, CHAT_DEADLINE_MS)),
      );
      return re && re.kind === "commands" && re.commands.length ? re.commands[0] : null;
    };
    const runPlanWithUi = async (p: Plan): Promise<Plan> => {
      say(runId, `Plan ${p.id}: "${p.goal}" - ${p.steps.length} step(s). Each step is checkpointed; a failure pauses the plan instead of losing it.`);
      const done = await runPlan(p, planExecutor, planFixer, {
        onStep: (pl, i, phase) => {
          const s = pl.steps[i];
          if (phase === "start") emit({ ts: Date.now(), run_id: runId, kind: "status", state: "waiting", label: `plan ${pl.id} step ${i + 1}/${pl.steps.length}`, text: `Step ${i + 1}/${pl.steps.length}: ${s.cmd}` }, false);
          if (phase === "retry") say(runId, `Step ${i + 1} failed (${s.error || "error"}) - retrying once.`);
          if (phase === "corrected") say(runId, `Step ${i + 1} failed twice, so I'm trying a different way: ${s.cmd}`);
          if (phase === "done") emit({ ts: Date.now(), run_id: runId, kind: "status", state: "done", label: `plan ${pl.id} step ${i + 1} done`, text: `Step ${i + 1}/${pl.steps.length} done` }, false);
          if (phase === "failed") say(runId, `Step ${i + 1} "${s.cmd}" failed: ${s.error || "unknown error"}.`);
        },
      });
      if (done.status === "done") say(runId, `Plan ${done.id} finished - all ${done.steps.length} step(s) done.`);
      else if (done.status === "paused") say(runId, `Plan ${done.id} is paused at the failed step. Fix the cause and say \`resume plan ${done.id}\`, or \`cancel plan ${done.id}\`.`);
      return done;
    };


  try {
    // LLM intent router: plain English -> canonical commands (regex cascade stays as offline fallback + executor)
    if (!routed && !provider().offline) {
      const route = await routeWithModel(text, (msgs) => withProgress(runId, "Understanding your request", () => modelRace(runId, msgs, undefined, true), Math.min(15_000, CHAT_DEADLINE_MS)));
      if (route && route.kind === "clarify") {
        pendingClarify = { question: route.question, original: t, expires: Date.now() + 10 * 60_000 };
        say(runId, route.question);
        return;
      }
      if (route && route.kind === "commands" && route.commands.length) {
        if (route.commands.length === 1) {
          await handleUserMessage(route.commands[0], true);
          return;
        }
        // multi-step: durable plan with checkpoints, retries and self-correction (same machinery as "plan <goal>")
        say(runId, `Plan, ${route.commands.length} steps:\n${route.commands.map((c, i) => `${i + 1}) ${c}`).join("\n")}`);
        await runPlanWithUi(createPlan(t, route.commands));
        return;
      }
      if (route && route.kind === "chat") {
        // the model explicitly said conversation: skip the cascade, answer freely
        const reply = await toolCall(runId, "model.chat", { text: t }, async () => withProgress(runId, "Waiting for the model", () => modelRace(runId, [{ role: "user", content: t }])));
        say(runId, reply && reply.trim() ? reply : "The model returned an empty reply. Please try again.");
        return;
      }
      // route null (model down/unparseable): fall through to the regex cascade
    }

    if (lower === "help" || lower === "commands") {
      say(runId, [
        "What I understand (plain English works - \"can u apply to <url>\" is fine):",
        "- connect <gemini|groq|openrouter|model|email|drive|github|telegram|profile|any-service> - setup cards with secure storage",
        "- gemini-web on/off - experimental: answer via the Gemini website when every API is down (you log in once in the Browser tab)",
        "- search <query> - keyless web search (DuckDuckGo, then Bing)",
        "- hunt <query> - job hunt: shortlist -> \"apply to 1,3\" / \"apply all\" (tracked as Scouted)",
        "- open / browse <url> - drive the live browser (Browser tab)",
        "- sign up on <site> with google - signup engine w/ OTP assist + human takeover",
        "- apply to <job-url> - fill profile facts only, approval before submit",
        "- track <Company> - <role> / applications - application tracker",
        "- board <pipeline|inbox|overview> / boards - live shareable dashboards; unshare <kind> kills the link",
        "- plan <goal> / plans / resume plan <id> / cancel plan <id> - durable multi-step plans with retries + self-correction",
        "- caps / cap <action> <N> - per-day limits on sends and applications",
        "- send mail to <addr>: <body> - or plain English (\"send mail to x@y.com asking for a referral\"); I draft, you approve before sending",
        "- inbox / check mail - read recent mail",
        "- drive / upload <path> to drive [as doc] / sync <dir> to drive",
        "- git init <name> / commit <path> [msg] / push <path> / create github repo <name> / git status <path>",
        "- every <N> <minutes|hours> <command> / at <HH:MM> <command> / jobs - scheduler",
        "- linkedin / linkedin on / linkedin feed - LinkedIn assist (risk-gated)",
        "- linkedin message <profile-url>: <text> / connect with <profile-url> on linkedin - approval-gated, daily-capped",
        "- vault - list stored credentials (secrets never shown)",
      ].join("\n"));
      return;
    }

    // ---- setup cards ------------------------------------------------------
    const connect = lower.match(/^connect (\w[\w -]*)$/) || lower.match(/^set model key$/);
    if (connect) {
      const service = (connect[1] || "model").trim();
      emit({
        ts: Date.now(), run_id: runId, kind: "setup_form", service,
        fields: serviceFields(service),
      });
      return;
    }
    if (lower === "vault") {
      const rows = await toolCall(runId, "vault.list", {}, async () => listCredentials());
      say(runId, rows.length
        ? "Vault entries (secrets stay encrypted):\n" + rows.map((r) => `- ${r.service}: ${r.username}`).join("\n")
        : "Vault is empty. Say `connect <service>` to add credentials.");
      return;
    }

    // ---- job hunt: search -> shortlist -> apply picks -> tracker --------------
    const mHunt = cmd.match(/^(?:hunt|job hunt)\s+(.+)$/i)
      || cmd.match(/^(?:find|look for|search for)\s+(.+\b(?:jobs?|internships?|openings|roles)\b.*)$/i);
    if (mHunt) {
      const q = mHunt[1].replace(/^me\s+/i, "").trim();
      const results = await toolCall(runId, "jobs.hunt", { query: q }, () => webSearch(q));
      if (!results.length) {
        say(runId, `No results for "${q}". Try a different query.`);
        return;
      }
      const host = (u: string) => { try { return new URL(u).hostname; } catch { return u; } };
      const tracked = new Set(listApplications().map((a) => a.url).filter(Boolean));
      for (const r of results) {
        if (!tracked.has(r.url)) addApplication({ company: host(r.url), role: r.title.slice(0, 80), portal: host(r.url), url: r.url, status: "Scouted" });
      }
      pendingHunt = { results, expires: Date.now() + 15 * 60_000 };
      say(runId, [
        `Top ${results.length} hits for "${q}":`,
        ...results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${tracked.has(r.url) ? " (already tracked)" : ""}\n   ${r.snippet}`),
        "",
        "Reply `apply to 1` (or `apply to 1,3`, `apply all`) within 15 min and I'll fill those forms. New ones sit on the Jobs tab as Scouted.",
      ].join("\n"), { results });
      return;
    }

    // ---- web search / surf -------------------------------------------------
    const mSearch = lower.match(/^(?:search|surf|google|look up) (?:the web )?(?:for )?(.+)$/);
    if (mSearch) {
      const q = mSearch[1];
      const results = await toolCall(runId, "web.search", { query: q }, () => webSearch(q));
      say(runId, results.length
        ? `Top ${results.length} results for "${q}":\n` + results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n")
        : `No results for "${q}".`, { results });
      return;
    }

    // ---- durable plans: goal -> checkpointed steps -> retries + self-correction ----
    const mPlan = cmd.match(/^plan[\s:]+([\s\S]+)$/i);
    if (mPlan) {
      const goal = mPlan[1].trim();
      if (provider().offline) { say(runId, "Planning needs a connected model - say `connect groq` or `connect gemini` first (both free)."); return; }
      const route = await routeWithModel(goal, (msgs) => withProgress(runId, "Planning the steps", () => modelRace(runId, msgs, undefined, true), Math.min(15_000, CHAT_DEADLINE_MS)));
      if (route && route.kind === "clarify") {
        pendingClarify = { question: route.question, original: t, expires: Date.now() + 10 * 60_000 };
        say(runId, route.question);
        return;
      }
      if (!route || route.kind !== "commands" || !route.commands.length) {
        say(runId, "I couldn't break that into concrete steps. Name the actions (e.g. \"plan hunt react internships and track the results\").");
        return;
      }
      await runPlanWithUi(createPlan(goal, route.commands));
      return;
    }
    if (lower === "plans") {
      const ps = listPlans(10);
      say(runId, ps.length
        ? ps.map((p) => `- [${p.status}] plan ${p.id}: ${p.goal} (${p.steps.filter((s) => s.status === "done").length}/${p.steps.length} steps)`).join("\n")
        : "No plans yet. Try \"plan hunt backend internships and track what you find\".");
      return;
    }
    const mResume = cmd.match(/^(?:resume|retry)\s+plan\s+([a-f0-9]+)$/i);
    if (mResume) {
      const p = getPlan(mResume[1]);
      if (!p) { say(runId, `No plan with id ${mResume[1]}. Say \`plans\` to list them.`); return; }
      if (p.status === "done") { say(runId, `Plan ${p.id} already finished.`); return; }
      if (p.status === "cancelled") { say(runId, `Plan ${p.id} was cancelled - start a new one with \`plan <goal>\`.`); return; }
      await runPlanWithUi(p);
      return;
    }
    const mCancelPlan = cmd.match(/^cancel\s+plan\s+([a-f0-9]+)$/i);
    if (mCancelPlan) {
      const p = cancelPlan(mCancelPlan[1]);
      say(runId, p ? `Plan ${p.id} cancelled - remaining steps skipped. Its checkpoints stay on record.` : `No plan with id ${mCancelPlan[1]}.`);
      return;
    }

    // ---- per-action daily caps ----------------------------------------------
    const CAP_ALIASES: Record<string, string> = { "send mail": "send_mail", mail: "send_mail", email: "send_mail", apply: "apply", applications: "apply", "linkedin message": "linkedin_message", "linkedin invite": "linkedin_invite" };
    if (lower === "caps") {
      say(runId, "Today's action caps (used/limit):\n" + capStatus().map((c) => `- ${c.action.replace(/_/g, " ")}: ${c.used}/${c.cap}`).join("\n") + "\nRaise one with \"cap send mail 20\".");
      return;
    }
    const mCap = cmd.match(/^cap\s+([a-z ]+?)\s+(\d+)$/i);
    if (mCap) {
      const action = CAP_ALIASES[mCap[1].toLowerCase().trim()];
      if (!action) { say(runId, `Unknown action "${mCap[1]}". Caps exist for: ${Object.keys(CAP_ALIASES).join(", ")}.`); return; }
      setCap(action, Number(mCap[2]));
      say(runId, `Cap updated: ${action.replace(/_/g, " ")} now allows ${mCap[2]}/day.`);
      return;
    }

    // ---- boards: live shareable dashboards ---------------------------------
    const boardUrl = (b: { id: string; share_token: string }) => {
      const base = (getSetting("public_url") || `http://localhost:${process.env.PORT || 8787}`).replace(/\/$/, "");
      return `${base}/boards/${b.id}?k=${b.share_token}`;
    };
    const mUnshare = cmd.match(/^unshare\s+(pipeline|inbox|overview)$/i);
    if (mUnshare) {
      const { ensureBoard, rotateShareToken } = await import("./boards.js");
      const kind = mUnshare[1].toLowerCase() as any;
      rotateShareToken(ensureBoard(kind).id);
      say(runId, `Done - every old ${kind} link is dead. New link: ${boardUrl(ensureBoard(kind))}`);
      return;
    }
    const mBoard = cmd.match(/^boards?$/i) || cmd.match(/^board\s+(pipeline|inbox|overview)$/i);
    if (mBoard) {
      const { ensureBoard, boardKinds } = await import("./boards.js");
      const kind = (mBoard[1] || "").toLowerCase();
      if (kind) {
        const b = ensureBoard(kind as any);
        say(runId, `Your live ${b.title}: ${boardUrl(b)} - it updates itself as things change. Anyone with the link can view it; "unshare ${kind}" kills it.`);
      } else {
        say(runId, "Live dashboards (they update themselves):\n" + boardKinds().map((k) => `- ${k}: ${boardUrl(ensureBoard(k))}`).join("\n"));
      }
      return;
    }

    // ---- tracker -----------------------------------------------------------
    if (lower === "applications" || lower === "tracker") {
      const rows = await toolCall(runId, "tracker.list", {}, async () => listApplications());
      say(runId, rows.length
        ? `You have ${rows.length} tracked application(s). Latest: ${rows[0].company} (${rows[0].status}).`
        : "No applications tracked yet. The tracker tab is ready when you are.");
      return;
    }
    const mTrack = cmd.match(/^track (.+?)(?:\s*-\s*(.+))?$/i);
    if (mTrack) {
      const app = await toolCall(runId, "tracker.add", { company: mTrack[1], role: mTrack[2] }, async () =>
        addApplication({ company: mTrack[1].trim(), role: mTrack[2]?.trim() }));
      say(runId, `Tracked: ${app.company}${app.role ? ` - ${app.role}` : ""} (${app.status}).`);
      return;
    }

    // ---- plain-English email send (draft -> Send/Edit/Cancel card -> SMTP only on Send) ----
    const sendIntent = parseSendIntent(t);
    if (sendIntent) {
      const cap = checkCap("send_mail");
      if (!cap.allowed) {
        emit({ ts: Date.now(), run_id: runId, kind: "status", state: "denied", label: "send_mail", text: "send denied: daily cap reached" });
        say(runId, `Daily send cap reached (${cap.used}/${cap.cap} emails today). Nothing was drafted or sent - say \`cap send mail <N>\` to raise it.`);
        return;
      }
      const { listMailAccounts, findMailAccount, mailConfigured } = await import("./mail.js");
      const accounts = listMailAccounts();
      if (sendIntent.from && !findMailAccount(sendIntent.from)) {
        say(runId, `${sendIntent.from} isn't a connected mail account, so I can't send from it.${accounts.length ? ` Connected: ${accounts.map((a) => a.user).join(", ")}.` : " Connect one with `connect email`."}`);
        return;
      }
      const from = sendIntent.from || accounts[0]?.user || "";
      let subject: string;
      let body: string;
      if (sendIntent.explicitBody) {
        subject = "Hello from your agent";
        body = sendIntent.explicitBody;
      } else {
        const senderName = await profileSenderName();
        const p = provider();
        if (p.offline) {
          ({ subject, body } = fallbackDraft(t, sendIntent.to, senderName));
          say(runId, "No model is connected, so this is a plain draft from your own words - tap Edit in the card to polish it. (`connect gemini` gives you model-drafted emails.)");
        } else {
          try {
            ({ subject, body } = await toolCall(runId, "mail.draft", { to: sendIntent.to }, async () =>
              withProgress(runId, "Drafting the email", () => draftWithModel(runId, p, t, sendIntent.to, senderName))));
          } catch {
            ({ subject, body } = fallbackDraft(t, sendIntent.to, senderName));
            say(runId, "The model didn't come back with a draft, so I made a plain one from your words - tap Edit in the card to polish it.");
          }
        }
      }
      const payload = { to: sendIntent.to, from, subject, body };
      const card = requestApproval("send_email", `Send email from ${from || "(not connected)"} to ${sendIntent.to}`, payload, runId);
      const others = accounts.filter((a) => a.user.toLowerCase() !== from.toLowerCase());
      say(runId, [
        `Draft ready - nothing is sent until you tap Send.`,
        `To: ${sendIntent.to}`,
        `From: ${from || "(email not connected)"}`,
        `Subject: ${subject}`,
        "",
        body,
        others.length ? `\nAlso connected: ${others.map((a) => a.user).join(", ")} - tap Edit in the card and change From to switch accounts.` : "",
      ].join("\n"), { approval_id: card.id });
      const res = await waitApproval(card.id);
      if (res.status !== "approved") {
        emit({ ts: Date.now(), run_id: runId, kind: "status", state: "denied", label: "send_mail", text: res.status === "expired" ? "send approval expired" : "send rejected by user" });
        say(runId, res.status === "expired" ? "Approval expired - nothing sent." : "Cancelled - nothing sent.");
        return;
      }
      const pl = res.payload as any;
      if (!mailConfigured()) {
        say(runId, "Approved, but email isn't connected - nothing was sent. Say `connect email` first.");
        return;
      }
      if (pl.from && !findMailAccount(String(pl.from))) {
        const { listMailAccounts: relist } = await import("./mail.js");
        say(runId, `Not sent: ${pl.from} isn't a connected mail account. Connected: ${relist().map((a) => a.user).join(", ") || "none"}.`);
        return;
      }
      try {
        const result = await toolCall(runId, "mail.send", { to: pl.to, from: pl.from }, async () => {
          const { sendMail } = await import("./mail.js");
          return sendMail(pl.to, pl.subject || "(no subject)", pl.body || "", { from: pl.from });
        });
        recordAction("send_mail", String(pl.to));
        say(runId, `Email sent to ${pl.to} from ${result.from}.`);
      } catch (err: any) {
        say(runId, `Couldn't send: ${err?.message || err}. Nothing was sent - check the mail settings (\`connect email\`) and try again.`);
      }
      return;
    }

    // natural-language email requests ("check my email", "any new mails?") - never fall through silently
    const emailIntent = /\b(e-?mails?|inbox|gmail|mails?)\b/.test(lower) && !/^(send|connect|draft|write|compose)\b/.test(lower);
    if (lower === "inbox" || lower === "check mail" || lower === "check email" || emailIntent) {
      const msgs = await toolCall(runId, "mail.inbox", {}, async () => {
        const { mailConfigured, listInbox } = await import("./mail.js");
        if (!mailConfigured()) return null;
        return listInbox(5);
      });
      if (msgs === null) say(runId, "Email isn't connected yet, so I can't read your inbox. Type `connect email` to set it up.");
      else say(runId, msgs.length ? msgs.map((m: any) => `- ${m.subject} (${m.from})`).join("\n") : "Inbox is empty.");
      return;
    }

    // ---- linkedin messaging / invites (risk-gated, approval-gated, capped) ----
    const liAsk = parseLinkedinAsk(cmd);
    if (liAsk) {
      if (getSetting("linkedin_enabled") !== "1" || getSetting("linkedin_risk_accepted") !== "1") {
        say(runId, `LinkedIn assist is not enabled yet. Say \`linkedin\` to see the risk note, \`linkedin on\`, then \`i accept the linkedin risk\` first.`);
        return;
      }
      const action = liAsk.kind === "message" ? "linkedin_message" : "linkedin_invite";
      const summary = liAsk.kind === "message"
        ? `LinkedIn DM to ${liAsk.url}:\n\n${liAsk.text}`
        : `LinkedIn invite to ${liAsk.url}${liAsk.text ? ` with note:\n\n${liAsk.text}` : " (no note)"}`;
      const card = requestApproval(action, summary, { url: liAsk.url, text: liAsk.text }, runId);
      say(runId, "Review the card above - Approve sends it through your logged-in LinkedIn session (slow-paced, daily-capped), Reject cancels.", { approval_id: card.id });
      const res = await waitApproval(card.id);
      if (res.status !== "approved") {
        say(runId, res.status === "expired" ? "Approval expired - nothing sent." : "Cancelled - nothing sent.");
        return;
      }
      try {
        const detail = await toolCall(runId, `linkedin.${liAsk.kind === "message" ? "message" : "invite"}`, res.payload, async () => {
          const tools = await linkedinTools();
          const p = res.payload as any;
          const r = liAsk.kind === "message"
            ? await tools.sendMessage(p.url, p.text || "", async () => true)
            : await tools.sendInvite(p.url, p.text || "", async () => true);
          return r.detail;
        });
        say(runId, String(detail));
      } catch (err: any) {
        say(runId, err?.name === "LinkedInStopped" ? `Stopped: ${err.message}` : `Couldn't do that on LinkedIn: ${err?.message || err}. If LinkedIn wants a login or check, open it in the Browser tab and do it once by hand.`);
      }
      return;
    }

    // ---- experimental gemini-web provider --------------------------------
    if (lower === "gemini-web on" || lower === "connect gemini-web" || lower === "gemini web on") {
      setSetting("gemini_web_enabled", "1");
      say(runId, [
        "Experimental gemini-web provider is ON. Read this once:",
        "- It drives gemini.google.com in the app's browser with YOUR login - a way to use a Google AI Pro/Ultra plan's website-only quota when the free API is down.",
        "- One-time setup: open the Browser tab, take control, and sign into your spare Google account yourself. I never see or store the password.",
        "- It joins a model race ONLY when every API model already failed, paced to one call per 20s, so it stays out of the way.",
        "- Experimental: Google can change the page or block this at any time. `gemini-web off` disables it instantly.",
      ].join("\n"));
      return;
    }
    if (lower === "gemini-web off" || lower === "gemini web off") {
      setSetting("gemini_web_enabled", "0");
      say(runId, "gemini-web is off. Nothing will drive the Gemini website anymore.");
      return;
    }

    // ---- linkedin --------------------------------------------------------
    if (lower === "linkedin" || lower === "linkedin status") {
      const { linkedinRiskNote } = await import("../src/tools/linkedin.js");
      const enabled = getSetting("linkedin_enabled") === "1";
      const accepted = getSetting("linkedin_risk_accepted") === "1";
      say(runId, `${linkedinRiskNote()}\n\nStatus: ${enabled ? "enabled" : "disabled"}, risk note ${accepted ? "accepted" : "not accepted"}. Say \`linkedin on\` to enable, \`i accept the linkedin risk\`, then \`linkedin feed\`.`);
      return;
    }
    if (lower === "linkedin on") {
      setSetting("linkedin_enabled", "1");
      say(runId, "LinkedIn assist enabled (still needs the risk acceptance - say `i accept the linkedin risk`). Login happens manually in the Browser tab on first use.");
      return;
    }
    if (lower === "i accept the linkedin risk") {
      setSetting("linkedin_risk_accepted", "1");
      say(runId, "Noted. LinkedIn assist is live with slow pacing and daily caps. Say `linkedin feed`.");
      return;
    }
    if (lower === "linkedin feed") {
      if (getSetting("linkedin_enabled") !== "1" || getSetting("linkedin_risk_accepted") !== "1") {
        say(runId, "Say `linkedin` first to see the risk note and enable it.");
        return;
      }
      const posts = await toolCall(runId, "linkedin.feed", {}, async () => {
        const { LinkedInTools } = await import("../src/tools/linkedin.js");
        const { Store } = await import("../src/config.js");
        const store = new Store(DATA_DIR);
        store.saveSettings({ linkedin: { enabled: true, riskAccepted: true } } as any);
        const li = new LinkedInTools(store, DATA_DIR);
        if (!(await li.isLoggedIn())) return null;
        return li.readFeed(5);
      });
      if (posts === null) say(runId, "Not logged in. Open linkedin.com in the Browser tab and log in once - the session persists.");
      else say(runId, posts.length ? posts.map((p: any, i: number) => `${i + 1}. ${p.author}: ${p.text.slice(0, 140)}`).join("\n") : "Feed read - nothing new parsed.");
      return;
    }

    // ---- universal job applier ------------------------------------------
    const mApply = cmd.match(/^apply (?:to|for)(?: this job| this one| here)? (\S+)$/i);
    if (mApply) {
      await runApplyFlow(runId, mApply[1]);
      return;
    }

    // ---- drive -----------------------------------------------------------
    if (lower === "drive" || lower === "drive files") {
      const files = await toolCall(runId, "drive.list", {}, async () => {
        const { driveConfigured, listDriveFiles } = await import("./drive.js");
        if (!driveConfigured()) return null;
        return listDriveFiles(10);
      });
      if (files === null) say(runId, "Drive not connected - say `connect drive`.");
      else say(runId, files.length ? files.map((f: any) => `- ${f.name}${f.webViewLink ? ` - ${f.webViewLink}` : ""}`).join("\n") : "Drive is empty.");
      return;
    }
    const mUpload = cmd.match(/^upload (\S+) to drive( as doc)?$/i);
    if (mUpload) {
      const f = await toolCall(runId, "drive.upload", { path: mUpload[1] }, async () => {
        const { uploadToDrive } = await import("./drive.js");
        return uploadToDrive(mUpload[1], { asGoogleDoc: Boolean(mUpload[2]) });
      });
      say(runId, `Uploaded: ${f.name}${f.webViewLink ? ` - ${f.webViewLink}` : ""}`);
      return;
    }
    const mSync = cmd.match(/^sync (\S+) to drive$/i);
    if (mSync) {
      const r = await toolCall(runId, "drive.sync", { dir: mSync[1] }, async () => {
        const { syncFolder } = await import("./drive.js");
        return syncFolder(mSync[1]);
      });
      say(runId, `Synced: ${r.uploaded.length} uploaded (${r.uploaded.join(", ") || "none"}), ${r.skipped.length} unchanged.`);
      return;
    }

    // ---- git engine ------------------------------------------------------
    const mGitInit = cmd.match(/^(?:git init|new repo)(?:\s+(\S+))?$/i);
    if (mGitInit) {
      const name = (mGitInit[1] || "new-project").replace(/[^\w.-]/g, "-");
      const path = `${process.env.HOME || "."}/repos/${name}`;
      const r = await toolCall(runId, "git.init", { name }, async () => {
        const { initRepo } = await import("./git.js");
        return initRepo(path, name);
      });
      say(runId, `Repo ${r.created ? "created" : "already existed"} at ${r.path}.`);
      return;
    }
    const mCommit = cmd.match(/^commit (\S+)(?:\s+(.+))?$/i);
    if (mCommit) {
      const path = mCommit[1];
      const msg = mCommit[2] || "agent: checkpoint";
      const r = await toolCall(runId, "git.commit", { path, msg }, async () => {
        const { commitAll } = await import("./git.js");
        return commitAll(path, msg);
      });
      say(runId, r ? `Committed: ${r}` : "Nothing to commit - working tree clean.");
      return;
    }
    const mPush = cmd.match(/^push (\S+)(?:\s+(\S+))?(?:\s+(\S+))?$/i);
    if (mPush) {
      const path = mPush[1];
      const remote = mPush[2] || "origin";
      const branch = mPush[3] || "main";
      await toolCall(runId, "git.push", { path, remote, branch }, async () => {
        const { push } = await import("./git.js");
        return push(path, remote, branch);
      });
      say(runId, `Pushed ${branch} to ${remote}.`);
      return;
    }
    const mGhRepo = cmd.match(/^(?:create|make) (?:a )?github repo (\S+)$/i);
    if (mGhRepo) {
      const url = await toolCall(runId, "github.create_repo", { name: mGhRepo[1] }, async () => {
        const { createGithubRepo } = await import("./git.js");
        return createGithubRepo(mGhRepo[1]);
      });
      say(runId, `Created: ${url}`);
      return;
    }
    if (lower.startsWith("git status ")) {
      const path = cmd.slice("git status ".length).trim();
      const { statusSummary } = await import("./git.js");
      say(runId, await statusSummary(path));
      return;
    }

    // ---- signup engine -------------------------------------------------
    const mSignup = cmd.match(/^sign ?(?:me )?up (?:on|at|for) (\S+?)(?: with google)?$/i);
    if (mSignup) {
      const site = mSignup[1];
      const status = await toolCall(runId, "signup.google", { site }, async () => {
        const { signupWithGoogle } = await import("./signup.js");
        return signupWithGoogle(runId, site);
      });
      const msg: Record<string, string> = {
        completed: `Signed up on ${site}.`,
        pending_verification: `Signup on ${site} started - watch the Browser tab. If a code arrives by email, say \`finish signup ${site}\`.`,
        needs_human: `I hit a wall on ${site}. Take control in the Browser tab, finish the step, then tell me to continue.`,
        failed: `Couldn't find a Google sign-up option on ${site}. The Browser tab shows what I saw.`,
      };
      say(runId, msg[status as string] || `Signup on ${site}: ${status}`);
      return;
    }
    if (lower === "signups") {
      const { listSignups } = await import("./signup.js");
      const rows = listSignups();
      say(runId, rows.length
        ? rows.map((r: any) => `- ${r.site} via ${r.method}: ${r.status} (${new Date(r.ts).toLocaleString()})`).join("\n")
        : "No signups yet. Try `sign up on example.com with google`.");
      return;
    }

    // ---- scheduler ---------------------------------------------------------
    const sched = parseSchedule(lower);
    if (sched) {
      const job = await toolCall(runId, "scheduler.add", sched, async () => {
        const { addJob } = await import("./scheduler.js");
        return addJob(sched.command, sched.nextRun, sched.intervalMin);
      });
      say(runId, `Scheduled "${sched.command}" ${sched.intervalMin ? `every ${sched.intervalMin} min` : "once"} - first run ${new Date(sched.nextRun).toLocaleString()}. See the Vault & Scheduler tab.`, { job_id: job.id });
      return;
    }
    if (lower === "jobs" || lower === "schedule") {
      const { listJobs } = await import("./scheduler.js");
      const js = listJobs().filter((j) => j.next_ts < Number.MAX_SAFE_INTEGER);
      say(runId, js.length
        ? js.map((j) => `- ${j.spec.command} (${j.spec.interval_min ? `every ${j.spec.interval_min} min` : "once"}, next ${new Date(j.next_ts).toLocaleString()})${j.enabled ? "" : " [paused]"}`).join("\n")
        : "Nothing scheduled. Try `every 2 hours search AI internships` or `at 18:30 tracker`.");
      return;
    }

    // ---- email send with approval ------------------------------------------
    const mOpen = cmd.match(/^(?:open|browse|go to)\s+(\S+)$/i);
    if (mOpen) {
      const url = await toolCall(runId, "browser.navigate", { url: mOpen[1] }, async () => {
        const br = await import("./browser.js");
        return br.navigate(mOpen[1]);
      });
      say(runId, `Opened ${url}. Watch it in the Browser tab - flip "take control" there any time to solve a CAPTCHA or 2FA yourself.`);
      return;
    }

    // ---- fall through to the model ------------------------------------------
    const p = provider();
    if (p.offline) {
      say(runId, `I didn't recognise that as a command, and no AI model is connected yet, so I can't chat freely. Type \`connect gemini\` to add a free model, or \`help\` to see what I can do.`);
      return;
    }
    const reply = await toolCall(runId, "model.chat", { text: t }, async () => withProgress(runId, "Waiting for the model", () => modelRace(runId, [{ role: "user", content: t }])));
    say(runId, reply && reply.trim() ? reply : "The model returned an empty reply. Please try again.");
  } catch (err: any) {
    emit({ ts: Date.now(), run_id: runId, kind: "error", role: "agent", text: `Something failed: ${err?.message || err}` });
  }
}

function serviceFields(service: string) {
  switch (service) {
    case "gemini": case "google": case "google ai studio":
      return [
        { key: "model", label: `Model (blank = ${DEFAULT_GEMINI_MODEL}, best free-tier model)`, secret: false },
        { key: "model_api_key", label: "Gemini API key (free: aistudio.google.com > Get API key)", secret: true },
      ];
    case "groq":
      return [
        { key: "groq_api_key", label: "Groq API key (free: console.groq.com > API Keys). Joins every model race.", secret: true },
      ];
    case "openrouter":
      return [
        { key: "openrouter_api_key", label: "OpenRouter API key (free: openrouter.ai > Keys). Joins every model race.", secret: true },
      ];
    case "model": case "model key":
      return [
        { key: "model_base_url", label: "Base URL (OpenAI-compatible; blank = OpenAI. Groq: https://api.groq.com/openai/v1, OpenRouter: https://openrouter.ai/api/v1, Ollama: http://localhost:11434/v1)", secret: false },
        { key: "model", label: "Model name", secret: false },
        { key: "model_api_key", label: "API key", secret: true },
      ];
    case "profile":
      return [
        { key: "full_name", label: "Full name", secret: false },
        { key: "email", label: "Email", secret: false },
        { key: "phone", label: "Phone", secret: false },
        { key: "resume_path", label: "Resume file path (absolute)", secret: false },
        { key: "college", label: "College", secret: false },
        { key: "grad_year", label: "Graduation year", secret: false },
      ];
    case "drive": case "google drive":
      return [
        { key: "drive_client_id", label: "OAuth client ID", secret: false },
        { key: "drive_client_secret", label: "OAuth client secret", secret: true },
        { key: "drive_refresh_token", label: "Refresh token", secret: true },
      ];
    case "email": case "gmail":
      return [
        { key: "imap_host", label: "IMAP host (e.g. imap.gmail.com)", secret: false },
        { key: "smtp_host", label: "SMTP host (e.g. smtp.gmail.com)", secret: false },
        { key: "email_user", label: "Email address", secret: false },
        { key: "email_pass", label: "App password", secret: true },
      ];
    default:
      return [
        { key: "username", label: "Username / email", secret: false },
        { key: "secret", label: "Password / token", secret: true },
      ];
  }
}

/** Setup-card submission: validate + store. */
export async function handleSetupSubmit(service: string, values: Record<string, string>): Promise<string> {
  const runId = newRunId();
  const isGemini = service === "gemini" || service === "google" || service === "google ai studio";
  if (isGemini) {
    setSetting("model_provider", "gemini");
    setSetting("model_base_url", "");
    if (!values.model) setSetting("model", DEFAULT_GEMINI_MODEL);
  }
  if (service === "model" || service === "model key") setSetting("model_provider", "openai");
  for (const [k, v] of Object.entries(values)) {
    if (!v) continue;
    if (k === "email_pass" || k === "model_api_key" || k === "secret") {
      saveCredential(isGemini ? "gemini" : service, values.username || values.email_user || values.model || "default", v);
      if (k === "model_api_key") setSetting("model_api_key", v); // provider key also in settings for quick switch
    } else {
      setSetting(k, v);
    }
  }
  if (service === "profile") {
    const { ProfileStore } = await import("../src/tools/profile.js");
    const keyMap: Record<string, string> = { full_name: "firstName", email: "email", phone: "phone", resume_path: "resumePath", college: "university", grad_year: "graduationYear" };
    const patch: Record<string, string> = {};
    for (const [formKey, profileKey] of Object.entries(keyMap)) if (values[formKey]) patch[profileKey] = values[formKey];
    if (patch.firstName && patch.firstName.includes(" ")) {
      const parts = patch.firstName.trim().split(/\s+/);
      patch.firstName = parts[0];
      patch.lastName = parts.slice(1).join(" ");
    }
    const store = new ProfileStore(DATA_DIR);
    store.save(patch as any);
    say(runId, `Profile saved (${Object.keys(patch).length} fields). The job applier fills only these facts.`);
    return "ok";
  }
  // optional race keys: validate with a tiny ping, then they join every model race
  if (service === "groq" || service === "openrouter") {
    try {
      const key = getSetting(`${service}_api_key`) || "";
      if (!key) throw new Error("no key was stored - paste it into the card");
      const p = service === "groq"
        ? new OpenAiCompatibleProvider(process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile", key)
        : new OpenAiCompatibleProvider(process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1", "meta-llama/llama-3.3-70b-instruct:free", key);
      await p.chat([{ role: "user", content: "ping" }], { maxTokens: 4 });
      say(runId, `${service === "groq" ? "Groq" : "OpenRouter"} key works - it now joins every model race alongside your Gemini models.`);
      return "ok";
    } catch (err: any) {
      say(runId, `Saved, but validation failed: ${err?.message || err}. The key stays stored - fix it any time with \`connect ${service}\`.`);
      return "validation_failed";
    }
  }
  // live validation where possible
  if (service === "model" || service === "model key" || isGemini) {
    try {
      if (isGemini) {
        const { validateGeminiConnection } = await import("../src/providers/gemini.js");
        const key = getSetting("model_api_key") || "";
        if (!key) {
          say(runId, "Saved, but validation failed: no Gemini API key stored - run `connect gemini` again and paste the key into the card.");
          return "validation_failed";
        }
        const model = getSetting("model") || DEFAULT_GEMINI_MODEL;
        try {
          await validateGeminiConnection(model, key);
          say(runId, `Model connection OK (${model}).`);
        } catch (err: any) {
          // unknown model id -> fall back to a known-valid free model once
          if (err?.code === "model_not_found" && model !== FALLBACK_GEMINI_MODEL) {
            await validateGeminiConnection(FALLBACK_GEMINI_MODEL, key);
            setSetting("model", FALLBACK_GEMINI_MODEL);
            say(runId, `"${model}" was not found on the Gemini API, so you were switched to ${FALLBACK_GEMINI_MODEL} (free tier). Connection OK.`);
          } else {
            throw err;
          }
        }
        return "ok";
      }
      const p = provider();
      await p.chat([{ role: "user", content: "ping" }], { maxTokens: 4 });
      say(runId, `Model connection OK (${getSetting("model") || DEFAULT_OPENAI_MODEL}).`);
      return "ok";
    } catch (err: any) {
      say(runId, `Saved, but validation failed: ${err?.message || err}`);
      return "validation_failed";
    }
  }
  say(runId, `Saved ${service} settings${service === "email" ? ". (Live IMAP/SMTP check runs when you use mail commands.)" : "."}`);
  return "ok";
}
