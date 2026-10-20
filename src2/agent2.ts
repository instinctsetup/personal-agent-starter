/** v2 chat orchestration: command -> streamed events -> tools -> approvals. */
import { db } from "./db.js";
import { emit, newRunId, type AgentEvent } from "./bus.js";
import { requestApproval, waitApproval } from "./approvals.js";
import { webSearch } from "./search.js";
import { addApplication, listApplications } from "./tracker.js";
import { listCredentials, saveCredential, getCredential } from "./vault.js";
import { getSetting, setSetting, DATA_DIR } from "./db.js";
import { parseSchedule } from "./scheduler.js";
import { MockProvider } from "../src/providers/mock.js";

import { OpenAiCompatibleProvider } from "../src/providers/openai.js";
import { GeminiProvider } from "../src/providers/gemini.js";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash"; // most capable model on the free tier (verified against ai.google.dev/gemini-api/docs/pricing, Oct 2026)
export const FALLBACK_GEMINI_MODEL = "gemini-2.5-flash"; // stable free-tier fallback if the default is not found
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

function provider() {
  const key = getSetting("model_api_key");
  const kind = getSetting("model_provider") || "openai";
  if (kind === "gemini") {
    const model = getSetting("model") || DEFAULT_GEMINI_MODEL;
    return key ? new GeminiProvider(model, key) : new MockProvider();
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
async function draftWithModel(p: ReturnType<typeof provider>, request: string, to: string, senderName: string): Promise<{ subject: string; body: string }> {
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
  const raw = await p.chat([
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
  const line = referral
    ? `I wanted to ask if you could refer me${cleaned ? ` - ${cleaned}` : ""}.`
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


/** The apply flow for one posting: fill profile facts, ask missing ones in chat, approval card before submit. */
async function runApplyFlow(runId: string, url: string): Promise<void> {
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
    addApplication({ company: new URL(url).hostname, role: "", portal: new URL(url).hostname, url, status: "Applied" });
    say(runId, `Submitted. Filled ${result.filled.length} field(s). Tracked in Jobs & Tracker.`);
  } else {
    say(runId, `Not submitted (${result.status}). ${result.missing.length ? `Missing facts: ${result.missing.join(", ")}. Update with \`connect profile\`.` : result.summary || ""}`);
  }
}

export async function handleUserMessage(text: string): Promise<void> {
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

  try {
    if (lower === "help" || lower === "commands") {
      say(runId, [
        "What I understand (plain English works - \"can u apply to <url>\" is fine):",
        "- connect <gemini|model|email|drive|github|telegram|profile|any-service> - setup cards with secure storage",
        "- search <query> - keyless web search (DuckDuckGo, then Bing)",
        "- hunt <query> - job hunt: shortlist -> \"apply to 1,3\" / \"apply all\" (tracked as Scouted)",
        "- open / browse <url> - drive the live browser (Browser tab)",
        "- sign up on <site> with google - signup engine w/ OTP assist + human takeover",
        "- apply to <job-url> - fill profile facts only, approval before submit",
        "- track <Company> - <role> / applications - application tracker",
        "- send mail to <addr>: <body> - or plain English (\"send mail to x@y.com asking for a referral\"); I draft, you approve before sending",
        "- inbox / check mail - read recent mail",
        "- drive / upload <path> to drive [as doc] / sync <dir> to drive",
        "- git init <name> / commit <path> [msg] / push <path> / create github repo <name> / git status <path>",
        "- every <N> <minutes|hours> <command> / at <HH:MM> <command> / jobs - scheduler",
        "- linkedin / linkedin on / linkedin feed - LinkedIn assist (risk-gated)",
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
              withProgress(runId, "Drafting the email", () => draftWithModel(p, t, sendIntent.to, senderName))));
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
    const reply = await toolCall(runId, "model.chat", { text: t }, async () => withProgress(runId, "Waiting for the model", () => p.chat([{ role: "user", content: t }])));
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
