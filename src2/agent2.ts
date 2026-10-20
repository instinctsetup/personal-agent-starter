/** v2 chat orchestration: command -> streamed events -> tools -> approvals. */
import { db } from "./db.js";
import { emit, newRunId, onEvent, type AgentEvent } from "./bus.js";
import { requestApproval, waitApproval } from "./approvals.js";
import { checkCap, recordAction, capStatus, setCap, DEFAULT_CAPS } from "./caps.js";
import { createPlan, getPlan, listPlans, cancelPlan, runPlan, type Plan } from "./plans.js";
import { addMemory, listMemories, forgetMemory, forgetAll, memoryContext } from "./memory.js";
import { localEnabled, localStatus, ollamaChat, pullModel, setLocalEnabled } from "./local.js";
import { startSpan, endSpan, recentRuns, spanTree } from "./trace.js";
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
import { systemInfo, clipboardRead, clipboardWrite, launchApp, isKnownApp } from "./winops.js";
import { planRename, planDownloadsCleanup, applyMoves, undoLast, downloadsDir, fmtMoves, type Move } from "./fileops.js";
import { startWatch, stopWatch, listWatchers } from "./watcher.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveModel, currentModel, PROVIDERS, type ProviderId } from "./models.js";

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
  const { gateTool } = await import("./skills.js");
  const gate = gateTool(tool, input);
  if (!gate.allowed) {
    emit({ ts: Date.now(), run_id: runId, kind: "tool_result", tool, input, error: gate.reason, duration_ms: 0, state: "error" });
    throw new Error(gate.reason);
  }
  const started = Date.now();
  const spanId = startSpan(runId, tool, null, { input });
  emit({ ts: started, run_id: runId, kind: "tool_call", tool, input, state: "running" });
  try {
    const result = await fn();
    endSpan(spanId, "ok");
    emit({ ts: Date.now(), run_id: runId, kind: "tool_result", tool, input, result, duration_ms: Date.now() - started, state: "ok" });
    return result;
  } catch (err: any) {
    endSpan(spanId, "error", { error: String(err?.message || err).slice(0, 500) });
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
      label: `groq/${currentModel("groq")}`,
      run: (signal) => new OpenAiCompatibleProvider(process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1", currentModel("groq"), groqKey, signal).chat(messages, opts),
    });
  }
  const orKey = getSetting("openrouter_api_key");
  if (orKey) {
    racers.push({
      label: `openrouter/${currentModel("openrouter")}`,
      run: (signal) => new OpenAiCompatibleProvider(process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1", currentModel("openrouter"), orKey, signal).chat(messages, opts),
    });
  }
  const cbKey = getSetting("cerebras_api_key");
  if (cbKey) {
    racers.push({
      label: `cerebras/${currentModel("cerebras")}`,
      run: (signal) => new OpenAiCompatibleProvider(process.env.CEREBRAS_BASE_URL || "https://api.cerebras.ai/v1", currentModel("cerebras"), cbKey, signal).chat(messages, opts),
    });
  }
  const ghKey = getSetting("github_models_key");
  if (ghKey) {
    racers.push({
      label: `github-models/${currentModel("github-models")}`,
      run: (signal) => new OpenAiCompatibleProvider(process.env.GITHUB_MODELS_BASE_URL || "https://models.github.ai/inference", currentModel("github-models"), ghKey, signal).chat(messages, opts),
    });
  }
  if (localEnabled()) {
    const chatModel = getSetting("local_chat_model");
    if (chatModel) {
      racers.push({
        label: `local/${chatModel}`,
        run: () => ollamaChat(chatModel, messages as { role: string; content: string }[]),
      });
    }
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
export async function modelRace(runId: string, messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number }, quiet = false, maxRacers = RACE_MAX_RACERS): Promise<string> {
  const raceSpan = startSpan(runId, "model.race", null, { quiet });
  const racers = buildRacers(messages, opts).slice(0, maxRacers); // web provider joins round 2 only - see loop below
  if (racers.length === 0) return provider().chat(messages, opts); // offline/mock path
  if (racers.length === 1) return racers[0].run(new AbortController().signal);

  let lastErr: unknown;
  for (let round = 1; round <= RACE_ROUNDS; round++) {
    const roundRacers = round === 1 ? racers : buildRacers(messages, opts, true).slice(0, maxRacers + 1);
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
      endSpan(raceSpan, "ok", { winner: result.label, racers: roundRacers.length, round });
      return result.text;
    }
    if (round < RACE_ROUNDS) await sleep(RACE_BACKOFF_MS);
  }
  endSpan(raceSpan, "error", { error: "all racers failed" });
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

/** Conversational pending state is scoped per channel: a Telegram/Slack/scheduler message
 * must never be consumed as the answer to a question the web chat asked (and vice versa). */
export type ChannelId = string;
export const DEFAULT_CHANNEL: ChannelId = "web";

type PendingFacts = { questions: string[]; resolve: (a: Record<string, string> | null) => void; timer: ReturnType<typeof setTimeout> };
type PendingHunt = { results: import("./search.js").SearchResult[]; expires: number };
type PendingClarify = { question: string; original: string; expires: number };

/** One pending "the form needs these facts" question set per channel; the next message ON THAT CHANNEL answers it. */
const pendingFactsByChannel = new Map<ChannelId, PendingFacts>();
const pendingHuntByChannel = new Map<ChannelId, PendingHunt>();
const pendingClarifyByChannel = new Map<ChannelId, PendingClarify>();

/** Scheduler-triggered commands get their own disposable channel per job run, so they can
 * never answer (or be answered by) a human's in-flight conversation on another channel. */
export function schedulerChannel(jobId: string | number): ChannelId {
  return `scheduler:${jobId}:${Date.now()}`;
}


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
async function runApplyFlow(runId: string, url: string, channel: ChannelId): Promise<void> {
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
        if (pendingFactsByChannel.has(channel)) return {}; // this channel already has a question open - do not stack
        say(runId, [
          `The form needs ${qs.length} fact(s) I don't have:`,
          ...qs.map((q, i) => `${i + 1}. ${q}`),
          "",
          "Reply with the answers (one per line, same order), or `skip` to leave them empty. I never invent facts for you.",
        ].join("\n"));
        const answers = await new Promise<Record<string, string> | null>((resolve) => {
          const timer = setTimeout(() => {
            if (pendingFactsByChannel.get(channel)?.resolve === resolve) { pendingFactsByChannel.delete(channel); resolve(null); }
          }, 10 * 60 * 1000);
          pendingFactsByChannel.set(channel, { questions: qs, resolve, timer });
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

/** Free-chat grounding: the app's REAL capabilities + live connection state, so the model
 *  never denies a capability that exists and names the connect command for ones that don't. */
async function capabilityContext(): Promise<string> {
  const { mailConfigured } = await import("./mail.js");
  const { driveConfigured } = await import("./drive.js");
  const mail = mailConfigured();
  const drive = driveConfigured();
  const li = getSetting("linkedin_enabled") === "1";
  const apps = listApplications().length;
  return [
    "You are the assistant inside the user's own personal-agent app, with real tools and live data:",
    `- Email: ${mail ? "CONNECTED - you can search and read their inbox and send with their approval" : "NOT connected (they can say 'connect email' to add a Gmail app password)"}`,
    `- Google Drive: ${drive ? "CONNECTED - you can list and upload files" : "NOT connected (they can say 'connect drive')"}`,
    `- LinkedIn assist: ${li ? "ON" : "off ('linkedin on' enables it)"}`,
    `- Job tracker: ${apps} application(s) tracked; job hunt, applications, boards available`,
    "- Live browser (forms, signups, browsing), scheduling, durable memory and plans.",
    "Rules: NEVER claim you cannot access a CONNECTED service - the app can and does. If a question needs a live tool result you don't have in this chat, tell the user the exact thing to say (e.g. 'mail search <words>', 'drive', 'applications') instead of denying capability. If a service shows NOT connected, say so plainly and name the connect command.",
  ].join("\n");
}

/** Fire-and-forget: pull durable facts/preferences out of an exchange. Never blocks the reply; secrets are filtered in addMemory. */
function extractMemories(runId: string, userText: string, agentReply: string) {
  if (provider().offline) return;
  const msgs = [
    { role: "system" as const, content: 'You extract durable user facts and preferences from a chat exchange. Reply with a strict JSON array (possibly empty) of {"kind":"fact"|"preference","text":"..."}. Keep only things worth remembering next week: name, city, college, skills, preferences, constraints, recurring context. Never secrets, never one-off requests, never guesses. JSON array only.' },
    { role: "user" as const, content: `User said: """${userText.slice(0, 500)}"""\nAssistant replied: """${agentReply.slice(0, 500)}"""` },
  ];
  modelRace(runId, msgs, { maxTokens: 300 }, true, 1) // 1 racer: background memory extraction must not burn the free-tier daily quota on a 4-way race
    .then((raw) => {
      const m = raw.match(/\[[\s\S]*\]/);
      if (!m) return;
      const arr = JSON.parse(m[0]);
      if (!Array.isArray(arr)) return;
      for (const item of arr.slice(0, 5)) {
        if (item && (item.kind === "fact" || item.kind === "preference") && typeof item.text === "string") {
          addMemory(item.kind, item.text, "extracted");
        }
      }
    })
    .catch(() => { /* memory is best-effort, never user-facing */ });
}

/** Mail questions are commands, not conversation. Deterministic - beats a flaky router model. */
function matchMailQuery(cmd: string): { query: string; latest?: boolean } | null {
  const canonical = cmd.match(/^mail search\s+(.+)$/i) || cmd.match(/^mail from\s+(.+)$/i);
  if (canonical) return { query: canonical[1].trim() };
  if (/^latest (?:e-?mail|mail)$/i.test(cmd)) return { query: "", latest: true };
  if (/^(send|connect|draft|write|compose|reply)\b/i.test(cmd)) return null;
  let m = cmd.match(/^(?:what does|what's|whats)\s+(?:the\s+)?(.+?)\s+(?:e-?mail|mail)\s+say/i);
  if (m) return { query: m[1].trim() };
  m = cmd.match(/\bany\s+(?:reply|response|mail|e-?mail|news)\s+from\s+(.+?)[.?!]?$/i);
  if (m) return { query: m[1].trim() };
  m = cmd.match(/^(?:did|has|have)\s+(.+?)\s+(?:reply|replied|respond|write|written|send|sent|mail)(?:\s+back)?/i);
  if (m) return { query: m[1].trim() };
  m = cmd.match(/^(?:summari[sz]e|read|show)\s+(?:my\s+|the\s+)?(last|latest|recent)\s+(?:e-?mails?|mails?|inbox)$/i);
  if (m) return { query: "", latest: true };
  m = cmd.match(/^(?:summari[sz]e|read|show)\s+(?:my\s+|the\s+)?(.+?)\s+(?:e-?mail|mail)$/i);
  if (m) return { query: m[1].trim() };
  m = cmd.match(/^latest\s+(?:e-?mail|mail)\s+from\s+(.+)$/i);
  if (m) return { query: m[1].trim() };
  return null;
}

async function answerMailQuery(runId: string, q: { query: string; latest?: boolean }): Promise<void> {
  const { mailConfigured, searchMail, readMailBody } = await import("./mail.js");
  if (!mailConfigured()) {
    say(runId, "Email isn't connected yet, so there's no mailbox for me to read. To connect: say \`connect email\` and enter your Gmail address plus an app password (Google Account > Security > 2-Step Verification > App passwords). Once connected I can search and read your mail.");
    return;
  }
  let matches;
  try {
    matches = await toolCall(runId, "mail.search", { query: q.query }, () => searchMail(q.query));
  } catch (err: any) {
    say(runId, `Couldn't reach your mailbox: ${err?.message || err}. The connection details may need a refresh - say \`connect email\` to re-enter them.`);
    return;
  }
  if (!matches.length) {
    say(runId, q.query ? `Nothing in your recent mail matches "${q.query}" (searched the last 30). Try different words from the sender or subject.` : "Your inbox is empty.");
    return;
  }
  let body = "";
  if (q.query || q.latest) {
    try { body = await toolCall(runId, "mail.read", { uid: matches[0].uid }, () => readMailBody(matches[0].uid)); }
    catch { /* the summary list below still answers */ }
  }
  say(runId, [
    matches.length === 1 ? "Found it:" : `Found ${matches.length} matching mails - newest first:`,
    ...matches.map((m, i) => `${i + 1}. ${m.from}\n   ${m.subject}${m.date ? ` (${new Date(m.date).toLocaleString()})` : ""}`),
    body ? `\nThe newest one says:\n${body}` : `\nNewest snippet: ${matches[0].snippet}`,
  ].join("\n"), { results: matches });
}

export async function handleUserMessage(text: string, routed = false, channel: ChannelId = DEFAULT_CHANNEL): Promise<void> {
  const runId = newRunId();
  emit({ ts: Date.now(), run_id: runId, kind: "text", role: "user", text });
  const t = text.trim();
  const cmd = normalizeCommand(t);
  const lower = cmd.toLowerCase();

  /** A hunt shortlist waiting for the user's picks. */
  // (declared below; selection handled before command routing)

  // an apply/form flow ON THIS CHANNEL is waiting for missing facts - this message is the answer, not a new command
  const pendingFacts = pendingFactsByChannel.get(channel);
  if (pendingFacts) {
    const p = pendingFacts;
    pendingFactsByChannel.delete(channel);
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

  // a hunt shortlist ON THIS CHANNEL is open - "apply to 1,3" / "apply all" picks from it
  const pendingHunt = pendingHuntByChannel.get(channel);
  if (pendingHunt) {
    if (Date.now() > pendingHunt.expires) {
      pendingHuntByChannel.delete(channel);
    } else {
      const sel = cmd.match(/^(?:apply(?:\s+to)?\s+)?(all|\d+(?:\s*[, ]\s*\d+)*)$/i);
      if (sel) {
        const results = pendingHunt.results;
        pendingHuntByChannel.delete(channel);
        const picks = sel[1].toLowerCase() === "all"
          ? results
          : [...new Set(sel[1].split(/[\s,]+/).filter(Boolean).map(Number))].filter((n) => n >= 1 && n <= results.length).map((n) => results[n - 1]);
        if (!picks.length) {
          say(runId, "None of those numbers are on the shortlist. Run the hunt again and pick from the list.");
          return;
        }
        say(runId, `Applying to ${picks.length} posting(s), one at a time. Each still needs your approval before anything is submitted.`);
        for (const r of picks) await runApplyFlow(runId, r.url, channel);
        return;
      }
      // not a selection: keep the shortlist open and route normally
    }
  }

  // an LLM-router clarify question ON THIS CHANNEL is open - this message answers it
  const pendingClarify = pendingClarifyByChannel.get(channel);
  if (pendingClarify) {
    if (Date.now() > pendingClarify.expires || /^(skip|cancel|never\s?mind|stop)$/i.test(cmd)) {
      pendingClarifyByChannel.delete(channel);
      if (/^(skip|cancel|never\s?mind|stop)$/i.test(cmd)) { say(runId, "Cancelled."); return; }
    } else {
      const answered = pendingClarify;
      pendingClarifyByChannel.delete(channel);
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
        await handleUserMessage(cmd, true, channel);
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
      const planSpan = startSpan(runId, `plan:${p.goal.slice(0, 60)}`, null, { plan_id: p.id, steps: p.steps.length });
      const stepSpans = new Map<number, string>();
      const done = await runPlan(p, planExecutor, planFixer, {
        onStep: (pl, i, phase) => {
          const s = pl.steps[i];
          if (phase === "start") stepSpans.set(i, startSpan(runId, `plan.step ${i + 1}`, planSpan, { cmd: s.cmd }));
          if (phase === "done") { const id = stepSpans.get(i); if (id) endSpan(id, "ok"); }
          if (phase === "failed") { const id = stepSpans.get(i); if (id) endSpan(id, "error", { error: s.error || "" }); }
          if (phase === "start") emit({ ts: Date.now(), run_id: runId, kind: "status", state: "waiting", label: `plan ${pl.id} step ${i + 1}/${pl.steps.length}`, text: `Step ${i + 1}/${pl.steps.length}: ${s.cmd}` }, false);
          if (phase === "retry") say(runId, `Step ${i + 1} failed (${s.error || "error"}) - retrying once.`);
          if (phase === "corrected") say(runId, `Step ${i + 1} failed twice, so I'm trying a different way: ${s.cmd}`);
          if (phase === "done") emit({ ts: Date.now(), run_id: runId, kind: "status", state: "done", label: `plan ${pl.id} step ${i + 1} done`, text: `Step ${i + 1}/${pl.steps.length} done` }, false);
          if (phase === "failed") say(runId, `Step ${i + 1} "${s.cmd}" failed: ${s.error || "unknown error"}.`);
        },
      });
      endSpan(planSpan, done.status === "done" ? "ok" : "error", { final: done.status });
      if (done.status === "done") {
        say(runId, `Plan ${done.id} finished - all ${done.steps.length} step(s) done.`);
        addMemory("summary", `Completed plan: "${done.goal}" (${done.steps.map((s) => s.cmd).join("; ")})`, "system");
      }
      else if (done.status === "paused") say(runId, `Plan ${done.id} is paused at the failed step. Fix the cause and say \`resume plan ${done.id}\`, or \`cancel plan ${done.id}\`.`);
      return done;
    };


  try {
    // LLM intent router: plain English -> canonical commands (regex cascade stays as offline fallback + executor)
    // mail questions never reach free chat - deterministic, whatever the router model thinks
    if (!routed) {
      const mq = matchMailQuery(cmd);
      if (mq) { await answerMailQuery(runId, mq); return; }
    }

    if (!routed && !provider().offline) {
      const route = await routeWithModel(text, (msgs) => withProgress(runId, "Understanding your request", async () => {
        const routerModel = localEnabled() ? getSetting("local_router_model") : null;
        if (routerModel) {
          try { return await ollamaChat(routerModel, msgs as { role: string; content: string }[], 8000); }
          catch { /* local router down/slow - the cloud race takes it */ }
        }
        return modelRace(runId, msgs, undefined, true);
      }, Math.min(15_000, CHAT_DEADLINE_MS)), memoryContext());
      if (route && route.kind === "clarify") {
        pendingClarifyByChannel.set(channel, { question: route.question, original: t, expires: Date.now() + 10 * 60_000 });
        say(runId, route.question);
        return;
      }
      if (route && route.kind === "commands" && route.commands.length) {
        if (route.commands.length === 1) {
          await handleUserMessage(route.commands[0], true, channel);
          return;
        }
        // multi-step: durable plan with checkpoints, retries and self-correction (same machinery as "plan <goal>")
        say(runId, `Plan, ${route.commands.length} steps:\n${route.commands.map((c, i) => `${i + 1}) ${c}`).join("\n")}`);
        await runPlanWithUi(createPlan(t, route.commands));
        return;
      }
      if (route && route.kind === "chat") {
        // the model explicitly said conversation: skip the cascade, answer freely (capabilities + memory in context)
        const cap = await capabilityContext();
        const mem = memoryContext();
        const sys = [cap, mem].filter(Boolean).join("\n\n");
        const chatMsgs = [{ role: "system" as const, content: sys }, { role: "user" as const, content: t }];
        const reply = await toolCall(runId, "model.chat", { text: t }, async () => withProgress(runId, "Waiting for the model", () => modelRace(runId, chatMsgs)));
        const out = reply && reply.trim() ? reply : "The model returned an empty reply. Please try again.";
        say(runId, out);
        extractMemories(runId, t, out);
        return;
      }
      // route null (model down/unparseable): fall through to the regex cascade
    }

    if (lower === "help" || lower === "commands") {
      say(runId, [
        "What I understand (plain English works - \"can u apply to <url>\" is fine):",
        "- connect <gemini|groq|openrouter|cerebras|github models|model|email|drive|github|telegram|profile|any-service> - setup cards with secure storage",
        "- gemini-web on/off - experimental: answer via the Gemini website when every API is down (you log in once in the Browser tab)",
        "- search <query> - keyless web search (DuckDuckGo, then Bing)",
        "- hunt <query> - job hunt: shortlist -> \"apply to 1,3\" / \"apply all\" (tracked as Scouted)",
        "- open / browse <url> - drive the live browser (Browser tab)",
        "- sign up on <site> with google - signup engine w/ OTP assist + human takeover",
        "- signups - list completed signups",
        "- apply to <job-url> - fill profile facts only, approval before submit",
        "- fill form <url> - Google Forms & web forms: reads every question, answers from your profile/memory, asks you for unknowns, review card before submit, confirmation screenshot",
        "- track <Company> - <role> / applications - application tracker",
        "- board <pipeline|inbox|overview> / boards - live shareable dashboards; unshare <kind> kills the link",
        "- plan <goal> / plans / resume plan <id> / cancel plan <id> - durable multi-step plans with retries + self-correction",
        "- caps / cap <action> <N> - per-day limits on sends and applications",
        "- remember <fact> / memories / forget <id> - durable memory across sessions (secrets stay in the vault)",
        "- note: <text> / notes - quick timestamped notes; remind me at 5pm to <text> / remind me in 30 minutes to <text> - one-shot nudges",
        "- local / local setup / local on|off - private on-device models via Ollama (auto-detects your GPU, cloud race as fallback)",
        "- skills - the full tool manifest (what I can do, risk tier, caps and approval gates per tool)",
        "- traces / trace <run-id> - structured run logs: every tool call as a timed span tree",
        "- send mail to <addr>: <body> - or plain English (\"send mail to x@y.com asking for a referral\"); I draft, you approve before sending",
        "- inbox / check mail - read recent mail",
        "- mail search <words> / latest mail - find and read mail (\"what does the 2step mail say\", \"any reply from Priya\")",
        "- drive / upload <path> to drive [as doc] / sync <dir> to drive",
        "- git init <name> / commit <path> [msg] / push <path> / create github repo <name> / git status <path>",
        "- every <N> <minutes|hours> <command> / at <HH:MM> <command> / jobs - scheduler",
        "- linkedin / linkedin on / linkedin feed - LinkedIn assist (risk-gated)",
        "- linkedin message <profile-url>: <text> / connect with <profile-url> on linkedin - approval-gated, daily-capped",
        "- vault - list stored credentials (secrets never shown)",
        "- laptop status - battery, RAM, disk free, CPU at a glance",
        "- what's on my clipboard / copy <text> - read or set the clipboard",
        "- open <app> - launch an allow-listed app (chrome, vscode, notepad, calculator, explorer, spotify); open <url> still browses",
        "- rename files in <dir> from <text> to <text> - batch rename with an approval card + undo last rename",
        "- clean up my downloads - archives files older than 30 days into _archive/<month>/ (approval card shows every move; daily-capped; undo last cleanup)",
        "- watch <folder> [for new <ext>] / watching / unwatch <folder> - get pinged the moment a new file lands (survives restarts)",
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
      pendingHuntByChannel.set(channel, { results, expires: Date.now() + 15 * 60_000 });
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
        pendingClarifyByChannel.set(channel, { question: route.question, original: t, expires: Date.now() + 10 * 60_000 });
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

    // ---- local SLMs via Ollama ----------------------------------------------
    if (lower === "local" || lower === "local status") {
      const st = await toolCall(runId, "local.status", {}, () => localStatus());
      if (!st.ollama) {
        say(runId, [
          "Ollama isn't running (or isn't installed). Local models are optional - the free cloud race already covers you.",
          "To add private, offline, zero-quota answers: install Ollama from https://ollama.com/download/windows, then say `local setup`.",
        ].join("\n"));
        return;
      }
      if (!st.tier) {
        say(runId, `Ollama is running, but ${st.vramMb ? `your GPU has only ${st.vramMb}MB VRAM` : "I couldn't find an NVIDIA GPU"} - local models aren't worth it here. The cloud race carries the load. (CPU-only models would be painfully slow; I won't pretend otherwise.)`);
        return;
      }
      say(runId, [
        `Local models: ${st.enabled ? "ON" : "OFF"} - ${st.tier.note}`,
        `- chat model: ${st.tier.chat} ${st.ready.includes(st.tier.chat) ? "(pulled)" : "(not pulled)"}`,
        `- router model: ${st.tier.router} ${st.ready.includes(st.tier.router) ? "(pulled)" : "(not pulled)"}`,
        st.missing.length ? `Say \`local setup\` to pull ${st.missing.join(" and ")} (one-time download).` : st.enabled ? "Routing runs on the 1B model locally; chat races your local 2B against the free cloud - first good answer wins." : "Say \`local on\` to use them.",
      ].join("\n"));
      return;
    }
    if (lower === "local on") {
      const st = await toolCall(runId, "local.status", {}, () => localStatus());
      if (!st.ollama || !st.tier) { say(runId, "Ollama or a usable GPU isn't there - see `local status`."); return; }
      if (st.missing.length) { say(runId, `Pull the model(s) first: \`local setup\` (${st.missing.join(", ")} missing).`); return; }
      setLocalEnabled(true);
      setSetting("local_chat_model", st.tier.chat);
      setSetting("local_router_model", st.tier.router);
      say(runId, `Local models on: ${st.tier.chat} joins the answer race, ${st.tier.router} handles routing privately on your GPU. If either stumbles, the free cloud race takes over automatically.`);
      return;
    }
    if (lower === "local off") {
      setLocalEnabled(false);
      say(runId, "Local models off - everything runs on the free cloud race again.");
      return;
    }
    if (lower === "local setup") {
      const st = await toolCall(runId, "local.status", {}, () => localStatus());
      if (!st.ollama) { say(runId, "Install Ollama first: https://ollama.com/download/windows - then say `local setup` again."); return; }
      if (!st.tier) { say(runId, "No usable NVIDIA GPU found (or under 2GB VRAM) - skipping local models honestly; the cloud race is the right answer on this machine."); return; }
      if (!st.missing.length) { say(runId, `Both models are already pulled. Say \`local on\`.`); return; }
      for (const m of st.missing) {
        say(runId, `Pulling ${m} (one-time download, a few hundred MB)...`);
        let lastPct = -20;
        try {
          await pullModel(m, (pct, detail) => {
            if (pct - lastPct >= 20) { lastPct = pct; emit({ ts: Date.now(), run_id: runId, kind: "status", state: "waiting", label: `pull ${m}`, text: `Pulling ${m}: ${pct}% (${detail})` }, false); }
          });
        } catch (e: any) {
          say(runId, `Pull of ${m} failed: ${e?.message || e}. Check Ollama is running (\`ollama serve\`) and try \`local setup\` again.`);
          return;
        }
        say(runId, `${m} pulled.`);
      }
      setSetting("local_chat_model", st.tier.chat);
      setSetting("local_router_model", st.tier.router);
      setLocalEnabled(true);
      const envNote = "For more context on a 4GB card: set OLLAMA_KV_CACHE_TYPE=q8_0 and OLLAMA_FLASH_ATTENTION=1 (halves context memory).";
      say(runId, `Local models ready and ON: ${st.tier.chat} (chat) + ${st.tier.router} (routing). Verify GPU residency anytime with \`ollama ps\` (PROCESSOR should read 100% GPU). ${envNote}`);
      return;
    }

    // ---- traces: structured run logs -------------------------------------------
    if (lower === "traces" || lower === "runs") {
      const runs = recentRuns(10);
      say(runId, runs.length
        ? "Recent runs:\n" + runs.map((r) =>
            `- ${r.run_id} - ${(r.duration_ms / 1000).toFixed(1)}s, ${r.spans} span(s)${r.errors ? `, ${r.errors} error(s)` : ""} - ${r.tools.slice(0, 4).join(", ")}${r.tools.length > 4 ? "…" : ""}`
          ).join("\n") + "\nSay \`trace <run-id>\` for the full span tree of one run."
        : "No runs recorded yet - traces appear as soon as tools run.");
      return;
    }
    const mTrace = cmd.match(/^trace\s+([a-z0-9-]+)$/i);
    if (mTrace) {
      const tree = spanTree(mTrace[1]);
      say(runId, tree.length
        ? `Run ${mTrace[1]}:\n` + tree.map((s) =>
            `${"  ".repeat(s.depth)}${s.status === "error" ? "✗" : "✓"} ${s.name} (${(((s.end_ts ?? s.start_ts) - s.start_ts) / 1000).toFixed(1)}s)${s.status === "error" && s.attrs.error ? ` - ${String(s.attrs.error).slice(0, 80)}` : ""}${s.attrs.winner ? ` - winner: ${s.attrs.winner}` : ""}`
          ).join("\n")
        : `No spans for run ${mTrace[1]}.`);
      return;
    }

    // ---- skills: the capability manifest --------------------------------------
    if (lower === "skills" || lower === "tools") {
      const { skillManifest } = await import("./skills.js");
      const m = skillManifest();
      say(runId, `I have ${m.length} registered tools:\n` + m.map((t) =>
        `- ${t.name} (${t.risk}${t.approval ? ", approval-gated" : ""}${t.cap ? `, capped/day` : ""}) - ${t.description}`
      ).join("\n"));
      return;
    }

    // ---- memory --------------------------------------------------------------
    const mRemember = cmd.match(/^remember(?:\s+that)?\s+([\s\S]+)$/i);
    if (mRemember) {
      const m = addMemory("fact", mRemember[1], "user");
      say(runId, m ? `Noted - I'll remember that. (id ${m.id}; "forget ${m.id}" removes it)` : "That looks like a secret (password, card, OTP, key) - I keep those in the vault only, never in memory.");
      return;
    }

    // ---- notes & reminders -------------------------------------------------
    const mNote = cmd.match(/^note:?\s+([\s\S]+)$/i);
    if (mNote) {
      const m = addMemory("note", mNote[1], "user");
      say(runId, m ? `Noted. (id ${m.id}; "forget ${m.id}" removes it)` : "That looks like a secret - I keep those in the vault only, never in notes.");
      return;
    }
    if (/^notes$/i.test(cmd)) {
      const notes = listMemories(200).filter((x) => x.kind === "note");
      say(runId, notes.length
        ? "Your notes:\n" + notes.map((x) => `- [${new Date(x.ts).toLocaleString()}] ${x.text} (id ${x.id})`).join("\n")
        : "No notes yet. Try `note: ask recruiter about remote work`.");
      return;
    }

    // scheduler-fired reminder: "remind: <text>" is the one-shot job's command
    const mReminderFire = cmd.match(/^remind:\s*([\s\S]+)$/i);
    if (mReminderFire) {
      say(runId, `Reminder: ${mReminderFire[1]}`);
      return;
    }

    // "remind me at 5pm to follow up" / "remind me at 17:30 to call" / "remind me in 30 minutes to stretch"
    const mRemind = cmd.match(/^remind me\s+(at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?|in\s+(\d+)\s*(minutes?|mins?|hours?|hrs?))\s+(?:to\s+)?([\s\S]+)$/i);
    if (mRemind) {
      let target: number;
      if (mRemind[5]) {
        const n = Number(mRemind[5]);
        target = Date.now() + n * (/^h/i.test(mRemind[6]) ? 3_600_000 : 60_000);
      } else {
        let h = Number(mRemind[2]);
        const mins = Number(mRemind[3] || "0");
        const ampm = (mRemind[4] || "").toLowerCase();
        if (ampm === "pm" && h < 12) h += 12;
        if (ampm === "am" && h === 12) h = 0;
        const d = new Date();
        d.setHours(h, mins, 0, 0);
        if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
        target = d.getTime();
      }
      const text = mRemind[7].trim();
      if (!text) {
        say(runId, "Remind you to do what? Try `remind me at 5pm to follow up with the recruiter`.");
        return;
      }
      const job = await toolCall(runId, "scheduler.add", { command: `remind: ${text}`, nextRun: target }, async () => {
        const { addJob } = await import("./scheduler.js");
        return addJob(`remind: ${text}`, target, null);
      });
      say(runId, `I'll remind you ${new Date(target).toLocaleString()}: "${text}".`, { job_id: job.id });
      return;
    }
    if (lower === "memories" || lower === "memory" || lower === "what do you remember") {
      const rows = listMemories(30);
      say(runId, rows.length
        ? `I remember ${rows.length} thing(s):\n` + rows.map((r) => `- (${r.kind}) ${r.text}  [${r.id}]`).join("\n") + `\nSay "forget <id>" to remove one, "forget everything" to wipe.`
        : "Nothing stored yet. Say \"remember <fact>\" - I also pick up durable facts and preferences as we chat.");
      return;
    }
    const mForget = cmd.match(/^forget\s+([\s\S]+)$/i);
    if (mForget) {
      if (/^everything$|^all$/i.test(mForget[1].trim())) {
        const n = forgetAll();
        say(runId, `Done - ${n} memor${n === 1 ? "y" : "ies"} wiped.`);
      } else {
        const n = forgetMemory(mForget[1].trim());
        say(runId, n ? `Forgot ${n} memor${n === 1 ? "y" : "ies"}.` : `Nothing matched "${mForget[1].trim()}". Say \`memories\` to see the ids.`);
      }
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
    const canonicalMailQ = matchMailQuery(cmd);
    if (canonicalMailQ && lower !== "inbox") { await answerMailQuery(runId, canonicalMailQ); return; }
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
      const cap = checkCap(action);
      if (!cap.allowed) {
        emit({ ts: Date.now(), run_id: runId, kind: "status", state: "denied", label: action, text: `${action} denied: daily cap reached` });
        say(runId, `Daily LinkedIn ${liAsk.kind} cap reached (${cap.used}/${cap.cap}). Nothing was drafted - say \`cap "linkedin ${liAsk.kind}" <N>\` to raise it.`);
        return;
      }
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
        recordAction(action, liAsk.url); // the cap ledger must reflect real LinkedIn sends
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
      await runApplyFlow(runId, mApply[1], channel);
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
      // Cross-platform home dir resolution (os.homedir() handles Windows USERPROFILE,
      // macOS/Linux HOME correctly) - process.env.HOME is unset on a plain Windows
      // shell, which previously made every repo land in a relative "./repos" next to
      // wherever the daemon process happened to be started from.
      const reposRoot = getSetting("repos_dir") || join(homedir(), "personal-agent-repos");
      mkdirSync(reposRoot, { recursive: true });
      const path = join(reposRoot, name);
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
    // ---- form filling: read questions -> profile/memory answers -> ask unknowns -> review -> submit ----
    const mForm = cmd.match(/^fill (?:the |this |out )?form\s+(\S+)$/i) || cmd.match(/^fill\s+(https?:\/\/\S*(?:forms\.gle|docs\.google\.com\/forms)\S*)$/i);
    if (mForm) {
      const url = mForm[1];
      say(runId, `Opening the form - I'll read every question, answer what I truly know from your profile and memory, and ask you for the rest. Watch the Browser tab if you like.`);
      const result = await toolCall(runId, "form.fill", { url }, async () => {
        const { runFormFill } = await import("./forms.js");
        const { ProfileStore } = await import("../src/tools/profile.js");
        const profile = new ProfileStore(DATA_DIR).get() as any;
        return runFormFill({ url, profile, resumePath: profile.resumePath || undefined }, {
          say: (text) => say(runId, text),
          askFacts: async (qs) => {
            if (pendingFactsByChannel.has(channel)) return {};
            say(runId, [
              ...qs.map((q, i) => `${i + 1}. ${q}`),
              "",
              "Reply with the answers (one per line, same order), or `skip` to leave them empty. I never invent answers for you.",
            ].join("\n"));
            const answers = await new Promise<Record<string, string> | null>((resolve) => {
              const timer = setTimeout(() => {
                if (pendingFactsByChannel.get(channel)?.resolve === resolve) { pendingFactsByChannel.delete(channel); resolve(null); }
              }, 10 * 60 * 1000);
              pendingFactsByChannel.set(channel, { questions: qs, resolve, timer });
            });
            if (answers === null) say(runId, "Skipped those - leaving them empty.");
            return answers ?? {};
          },
          confirm: async (summary, answers) => {
            const card = requestApproval("form_submit", summary, { url, answers }, runId);
            say(runId, summary + "\n\nApprove submits the form; Reject leaves everything filled but unsubmitted.", { approval_id: card.id });
            const res = await waitApproval(card.id);
            return res.status === "approved";
          },
        });
      });
      if (result.status === "submitted") {
        let saved = "";
        if (result.screenshot) {
          saved = join(DATA_DIR, `form-confirmation-${Date.now()}.jpg`);
          writeFileSync(saved, result.screenshot);
        }
        emit({ ts: Date.now(), run_id: runId, kind: "status", state: "done", label: "form.fill", text: "form submitted" });
        say(runId, [
          `Submitted - the confirmation is on screen${saved ? ` and saved at ${saved}` : ""}.`,
          `Answered ${Object.keys(result.answered).length} question(s) across ${result.pages} page(s).`,
          result.unknowns.length ? `Left empty: ${result.unknowns.join(", ")}.` : "",
        ].filter(Boolean).join("\n"), saved ? { screenshot: saved } : undefined);
      } else {
        emit({ ts: Date.now(), run_id: runId, kind: "status", state: "denied", label: "form.fill", text: `form not submitted (${result.status})` });
        say(runId, result.status === "cancelled"
          ? "Cancelled - the form stays filled in the Browser tab, nothing was submitted."
          : `Couldn't finish (${result.status}). ${result.error || ""}`);
      }
      return;
    }

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

    // ---- local machine: system info, clipboard, allow-listed app launcher ----
    if (/^(?:system info|sys ?info|laptop status|how'?s my (?:laptop|pc|computer)(?: doing)?|how is my (?:laptop|pc|computer)(?: doing)?)$/i.test(cmd)) {
      const info = await toolCall(runId, "system.info", {}, () => systemInfo());
      say(runId, info);
      return;
    }

    if (/^(?:what'?s|whats) on my clipboard\??$/i.test(cmd) || /^clipboard$/i.test(cmd)) {
      try {
        const clip = await toolCall(runId, "clipboard.read", {}, () => clipboardRead());
        say(runId, clip.trim() ? `On your clipboard:\n\n${clip}` : "Your clipboard is empty (or holds something that isn't text).");
      } catch {
        say(runId, "I couldn't read the clipboard on this machine.");
      }
      return;
    }

    const mCopy = cmd.match(/^copy ([\s\S]+)$/i);
    if (mCopy) {
      try {
        await toolCall(runId, "clipboard.write", { length: mCopy[1].length }, () => clipboardWrite(mCopy[1]));
        say(runId, `Copied ${mCopy[1].length} character(s) to your clipboard.`);
      } catch {
        say(runId, "I couldn't write to the clipboard on this machine.");
      }
      return;
    }

    const mLaunch = cmd.match(/^launch\s+(\w+)$/i);
    if (mLaunch) {
      try {
        const label = await toolCall(runId, "app.launch", { app: mLaunch[1] }, () => launchApp(mLaunch[1]));
        say(runId, `Opening ${label}.`);
      } catch (err: any) {
        say(runId, err?.message || "Couldn't open that app.");
      }
      return;
    }

    // ---- batch rename & downloads cleanup (approval-gated, undoable) --------
    const mRename = cmd.match(/^rename files in\s+(.+?)\s+from\s+(.+?)\s+to\s+(.+)$/i);
    if (mRename) {
      const [, dir, find, replace] = mRename;
      try {
        const moves = planRename(dir, find, replace);
        if (!moves.length) { say(runId, `No files in ${dir} contain "${find}" in their name.`); return; }
        const summary = `Rename ${moves.length} file(s) in ${dir}:\n${fmtMoves(moves)}\n\nApprove applies the renames (undo last rename reverses them).`;
        const card = requestApproval("fs_rename", summary, { moves }, runId);
        say(runId, summary, { approval_id: card.id });
        const res = await waitApproval(card.id);
        if (res.status !== "approved") {
          say(runId, res.status === "expired" ? "Approval expired - nothing renamed." : "Cancelled - nothing renamed.");
          return;
        }
        const approved = (res.payload?.moves ?? moves) as Move[];
        const done = await toolCall(runId, "fs.rename", { count: approved.length }, async () => applyMoves(approved, "rename"));
        say(runId, `Renamed ${done.length} file(s). Say \`undo last rename\` to reverse.`);
      } catch (err: any) {
        say(runId, err?.message || "Couldn't rename those files.");
      }
      return;
    }
    if (/^undo last rename$/i.test(cmd)) {
      try {
        const r = await toolCall(runId, "fs.undo_rename", {}, async () => undoLast("rename"));
        say(runId, `Undid ${r.reversed} rename(s).${r.skipped ? ` ${r.skipped} could not be reversed (file moved or name taken since).` : ""}`);
      } catch (err: any) {
        say(runId, err?.message || "Nothing to undo.");
      }
      return;
    }

    if (/^clean up my downloads$/i.test(cmd)) {
      const cap = checkCap("cleanup");
      if (!cap.allowed) {
        say(runId, `Daily cleanup cap reached (${cap.used}/${cap.cap}). Say \`cap cleanup <N>\` to raise it.`);
        return;
      }
      try {
        const dir = downloadsDir();
        const moves = planDownloadsCleanup(dir);
        if (!moves.length) { say(runId, "Nothing older than 30 days in Downloads - it's already tidy."); return; }
        const summary = `Archive ${moves.length} file(s) from Downloads into _archive/<month>/:\n${fmtMoves(moves)}\n\nApprove moves them (undo last cleanup reverses it).`;
        const card = requestApproval("fs_cleanup", summary, { moves }, runId);
        say(runId, summary, { approval_id: card.id });
        const res = await waitApproval(card.id);
        if (res.status !== "approved") {
          say(runId, res.status === "expired" ? "Approval expired - nothing moved." : "Cancelled - nothing moved.");
          return;
        }
        const approved = (res.payload?.moves ?? moves) as Move[];
        const done = await toolCall(runId, "fs.cleanup", { count: approved.length }, async () => applyMoves(approved, "cleanup"));
        recordAction("cleanup", dir);
        say(runId, `Archived ${done.length} file(s) into _archive/<month>/. Say \`undo last cleanup\` to reverse.`);
      } catch (err: any) {
        say(runId, err?.message || "Couldn't clean up Downloads.");
      }
      return;
    }
    if (/^undo last cleanup$/i.test(cmd)) {
      try {
        const r = await toolCall(runId, "fs.undo_cleanup", {}, async () => undoLast("cleanup"));
        say(runId, `Restored ${r.reversed} file(s) to Downloads.${r.skipped ? ` ${r.skipped} could not be restored.` : ""}`);
      } catch (err: any) {
        say(runId, err?.message || "Nothing to undo.");
      }
      return;
    }

    // ---- folder watcher -----------------------------------------------------
    const mWatch = cmd.match(/^watch\s+(.+?)(?:\s+for new\s+(\w+))?$/i);
    if (mWatch) {
      try {
        const spec = startWatch(mWatch[1].trim(), mWatch[2] || null);
        say(runId, `Watching ${spec.dir}${spec.ext ? ` for new ${spec.ext} files` : " for any new file"} - I'll ping you here the moment one lands. (\`${spec.id}\`; "unwatch ${spec.dir}" stops it.)`);
      } catch (err: any) {
        say(runId, err?.message || "Couldn't watch that folder.");
      }
      return;
    }
    if (/^(?:watching|watchers)$/i.test(cmd)) {
      const ws = listWatchers();
      say(runId, ws.length
        ? "Watching:\n" + ws.map((w) => `- ${w.dir}${w.ext ? ` (${w.ext} only)` : ""} [${w.id}]`).join("\n")
        : "Not watching any folder. Try `watch C:\\Users\\you\\Downloads for new pdf`.");
      return;
    }
    const mUnwatch = cmd.match(/^unwatch\s+(.+)$/i);
    if (mUnwatch) {
      say(runId, stopWatch(mUnwatch[1].trim()) ? "Stopped watching that folder." : "I wasn't watching that. Say `watching` to see the list.");
      return;
    }

    // ---- email send with approval ------------------------------------------
    const mOpen = cmd.match(/^(?:open|browse|go to)\s+(\S+)$/i);
    if (mOpen) {
      // "open chrome" / "open notepad" means the local app; "open <url>" still browses.
      if (isKnownApp(mOpen[1]) && !/\.|\//.test(mOpen[1])) {
        try {
          const label = await toolCall(runId, "app.launch", { app: mOpen[1] }, () => launchApp(mOpen[1]));
          say(runId, `Opening ${label}.`);
        } catch (err: any) {
          say(runId, err?.message || "Couldn't open that app.");
        }
        return;
      }
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
    const cap = await capabilityContext();
    const mem = memoryContext();
    const sys = [cap, mem].filter(Boolean).join("\n\n");
    const chatMsgs = [{ role: "system" as const, content: sys }, { role: "user" as const, content: t }];
    const reply = await toolCall(runId, "model.chat", { text: t }, async () => withProgress(runId, "Waiting for the model", () => modelRace(runId, chatMsgs)));
    const out = reply && reply.trim() ? reply : "The model returned an empty reply. Please try again.";
    say(runId, out);
    extractMemories(runId, t, out);
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
    case "cerebras":
      return [
        { key: "cerebras_api_key", label: "Cerebras API key (free: cloud.cerebras.ai > API Keys, 30 req/min, ~1M tokens/day). Joins every model race.", secret: true },
      ];
    case "github models": case "github-models":
      return [
        { key: "github_models_key", label: "GitHub personal access token (github.com > Settings > Developer settings > Tokens - free model access incl. gpt-4o-mini). Joins every model race.", secret: true },
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
  // optional race keys: resolve the model from the provider's live list, verify it, then it joins every race
  const raceService: Record<string, ProviderId> = { groq: "groq", openrouter: "openrouter", cerebras: "cerebras", "github models": "github-models", "github-models": "github-models" };
  if (raceService[service]) {
    const pid = raceService[service];
    try {
      const r = await resolveModel(pid);
      say(runId, `${PROVIDERS[pid].label} connected - using ${r.model} (${r.source === "live" ? "picked from your account's live model list" : "from the verified fallback list"}). It now joins every model race.`);
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
          // unknown model id -> resolve the best available model from the account's live list
          if (err?.code === "model_not_found") {
            const r = await resolveModel("gemini", key);
            say(runId, `"${model}" was not found on the Gemini API, so you were switched to ${r.model} (picked from your account's live model list). Connection OK.`);
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
