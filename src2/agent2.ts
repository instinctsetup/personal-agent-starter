/** v2 chat orchestration: command -> streamed events -> tools -> approvals. */
import { db } from "./db.js";
import { emit, newRunId, type AgentEvent } from "./bus.js";
import { requestApproval, waitApproval } from "./approvals.js";
import { webSearch } from "./search.js";
import { addApplication, listApplications } from "./tracker.js";
import { listCredentials, saveCredential, getCredential } from "./vault.js";
import { getSetting, setSetting } from "./db.js";
import { parseSchedule } from "./scheduler.js";
import { MockProvider } from "../src/providers/mock.js";

import { OpenAiCompatibleProvider } from "../src/providers/openai.js";

function provider() {
  const key = getSetting("model_api_key");
  const base = getSetting("model_base_url") || "https://api.openai.com/v1";
  const model = getSetting("model") || "gpt-4o-mini";
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

export async function handleUserMessage(text: string): Promise<void> {
  const runId = newRunId();
  emit({ ts: Date.now(), run_id: runId, kind: "text", role: "user", text });
  const t = text.trim();
  const lower = t.toLowerCase();

  try {
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
    const mTrack = t.match(/^track (.+?)(?:\s*-\s*(.+))?$/i);
    if (mTrack) {
      const app = await toolCall(runId, "tracker.add", { company: mTrack[1], role: mTrack[2] }, async () =>
        addApplication({ company: mTrack[1].trim(), role: mTrack[2]?.trim() }));
      say(runId, `Tracked: ${app.company}${app.role ? ` - ${app.role}` : ""} (${app.status}).`);
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
    const mOpen = t.match(/^(?:open|browse|go to)\s+(\S+)$/i);
    if (mOpen) {
      const url = await toolCall(runId, "browser.navigate", { url: mOpen[1] }, async () => {
        const br = await import("./browser.js");
        return br.navigate(mOpen[1]);
      });
      say(runId, `Opened ${url}. Watch it in the Browser tab - flip "take control" there any time to solve a CAPTCHA or 2FA yourself.`);
      return;
    }

    const mMail = t.match(/^send (?:an? )?(?:e-?)?mail to (\S+@\S+)(?:[:\s]+(.+))?$/is);
    if (mMail) {
      const payload = { to: mMail[1], subject: "Hello from your agent", body: mMail[2] || "(empty body - edit me)" };
      const card = requestApproval("send_email", `Send email to ${mMail[1]}`, payload, runId);
      say(runId, "Draft ready. Review the card above - you can edit every field before approving.", { approval_id: card.id });
      const res = await waitApproval(card.id);
      if (res.status === "approved") {
        await toolCall(runId, "mail.send", res.payload, async () => {
          if (!getSetting("smtp_host")) return { simulated: true, note: "SMTP not configured - no real email left this machine" };
          return { simulated: false };
        });
        say(runId, res.payload && getSetting("smtp_host") ? "Email sent." : "Approved. (No SMTP configured yet - nothing actually sent. Use `connect email`.)");
      } else {
        say(runId, res.status === "expired" ? "Approval expired - nothing sent." : "Rejected - nothing sent.");
      }
      return;
    }

    // ---- fall through to the model ------------------------------------------
    const reply = await toolCall(runId, "model.chat", { text: t }, async () => provider().chat([{ role: "user", content: t }]));
    say(runId, reply);
  } catch (err: any) {
    emit({ ts: Date.now(), run_id: runId, kind: "error", role: "agent", text: `Something failed: ${err?.message || err}` });
  }
}

function serviceFields(service: string) {
  switch (service) {
    case "model": case "model key":
      return [
        { key: "model_base_url", label: "Base URL (OpenAI-compatible; blank = OpenAI)", secret: false },
        { key: "model", label: "Model name", secret: false },
        { key: "model_api_key", label: "API key", secret: true },
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
  for (const [k, v] of Object.entries(values)) {
    if (!v) continue;
    if (k === "email_pass" || k === "model_api_key" || k === "secret") {
      saveCredential(service, values.username || values.email_user || values.model || "default", v);
      if (k === "model_api_key") setSetting("model_api_key", v); // provider key also in settings for quick switch
    } else {
      setSetting(k, v);
    }
  }
  // live validation where possible
  if (service === "model" || service === "model key") {
    try {
      const p = provider();
      await p.chat([{ role: "user", content: "ping" }], { maxTokens: 4 });
      say(runId, `Model connection OK (${getSetting("model") || "gpt-4o-mini"}).`);
      return "ok";
    } catch (err: any) {
      say(runId, `Saved, but validation failed: ${err?.message || err}`);
      return "validation_failed";
    }
  }
  say(runId, `Saved ${service} settings${service === "email" ? ". (Live IMAP/SMTP check runs when you use mail commands.)" : "."}`);
  return "ok";
}
