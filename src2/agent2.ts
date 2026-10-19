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

    if (lower === "inbox" || lower === "check mail" || lower === "check email") {
      const msgs = await toolCall(runId, "mail.inbox", {}, async () => {
        const { mailConfigured, listInbox } = await import("./mail.js");
        if (!mailConfigured()) return null;
        return listInbox(5);
      });
      if (msgs === null) say(runId, "Email not connected yet - say `connect email`.");
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
    const mApply = t.match(/^apply (?:to|for) (\S+)$/i);
    if (mApply) {
      const url = mApply[1];
      say(runId, `Starting the application flow for ${url}. I'll fill only profile facts, then show you an approval card before anything is submitted. Watch the Browser tab if you want.`);
      const result = await toolCall(runId, "jobs.apply", { url }, async () => {
        const { runJobApplication } = await import("../src/tools/apply.js");
        const { ProfileStore } = await import("../src/tools/profile.js");
        const profile = new ProfileStore(DATA_DIR).get();
        return runJobApplication({ url, profile, headless: true, dataDir: DATA_DIR }, {
          askFacts: async () => ({}), // unknown questions surface as `missing` instead of guesses
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
    const mUpload = t.match(/^upload (\S+) to drive( as doc)?$/i);
    if (mUpload) {
      const f = await toolCall(runId, "drive.upload", { path: mUpload[1] }, async () => {
        const { uploadToDrive } = await import("./drive.js");
        return uploadToDrive(mUpload[1], { asGoogleDoc: Boolean(mUpload[2]) });
      });
      say(runId, `Uploaded: ${f.name}${f.webViewLink ? ` - ${f.webViewLink}` : ""}`);
      return;
    }
    const mSync = t.match(/^sync (\S+) to drive$/i);
    if (mSync) {
      const r = await toolCall(runId, "drive.sync", { dir: mSync[1] }, async () => {
        const { syncFolder } = await import("./drive.js");
        return syncFolder(mSync[1]);
      });
      say(runId, `Synced: ${r.uploaded.length} uploaded (${r.uploaded.join(", ") || "none"}), ${r.skipped.length} unchanged.`);
      return;
    }

    // ---- git engine ------------------------------------------------------
    const mGitInit = t.match(/^(?:git init|new repo)(?:\s+(\S+))?$/i);
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
    const mCommit = t.match(/^commit (\S+)(?:\s+(.+))?$/i);
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
    const mPush = t.match(/^push (\S+)(?:\s+(\S+))?(?:\s+(\S+))?$/i);
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
    const mGhRepo = t.match(/^(?:create|make) (?:a )?github repo (\S+)$/i);
    if (mGhRepo) {
      const url = await toolCall(runId, "github.create_repo", { name: mGhRepo[1] }, async () => {
        const { createGithubRepo } = await import("./git.js");
        return createGithubRepo(mGhRepo[1]);
      });
      say(runId, `Created: ${url}`);
      return;
    }
    if (lower.startsWith("git status ")) {
      const path = t.slice("git status ".length).trim();
      const { statusSummary } = await import("./git.js");
      say(runId, await statusSummary(path));
      return;
    }

    // ---- signup engine -------------------------------------------------
    const mSignup = t.match(/^sign ?up (?:on|at|for) (\S+)(?: with google)?$/i);
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
        const result = await toolCall(runId, "mail.send", res.payload, async () => {
          const { mailConfigured, sendMail } = await import("./mail.js");
          if (!mailConfigured()) return { simulated: true, note: "email not connected - nothing left this machine" };
          const p = res.payload as any;
          return sendMail(p.to, p.subject || "(no subject)", p.body || "");
        });
        say(runId, (result as any)?.simulated === false ? `Email sent to ${(res.payload as any).to}.` : "Approved. (Email not connected - nothing actually sent. Use `connect email`.)");
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
  for (const [k, v] of Object.entries(values)) {
    if (!v) continue;
    if (k === "email_pass" || k === "model_api_key" || k === "secret") {
      saveCredential(service, values.username || values.email_user || values.model || "default", v);
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
