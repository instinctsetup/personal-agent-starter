/** Tool/skill registry: an MCP-style manifest of everything the agent can do.
 *  - typed argument schemas, validated on every registered call
 *  - risk tiers (read < write < identity < money) so exposure decisions are explicit
 *  - per-tool cap hooks into the daily action caps
 *  - the manifest feeds the UI ("skills" command, /api/skills) and future MCP exposure */
import { checkCap } from "./caps.js";

export type ArgSpec = { type: "string" | "number" | "boolean" | "url"; required?: boolean; description?: string };
export type Risk = "read" | "write" | "identity" | "money";

export type ToolSpec = {
  name: string;
  description: string;
  args: Record<string, ArgSpec>;
  risk: Risk;
  capAction?: string;             // when set, a denied cap blocks the call before it runs
  approval?: boolean;             // true when the tool itself already carries an approval gate
};

const registry = new Map<string, ToolSpec>();

export function registerTool(spec: ToolSpec) {
  registry.set(spec.name, spec);
}
export function getTool(name: string): ToolSpec | undefined {
  return registry.get(name);
}
export function listTools(): ToolSpec[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Validate args against the schema. Returns a human-readable violation, or null when clean. */
export function validateArgs(spec: ToolSpec, args: unknown): string | null {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a !== "object" || Array.isArray(a)) return `args for ${spec.name} must be an object`;
  for (const [key, s] of Object.entries(spec.args)) {
    const v = a[key];
    if (v === undefined || v === null || v === "") {
      if (s.required) return `${spec.name}: missing required argument "${key}"${s.description ? ` (${s.description})` : ""}`;
      continue;
    }
    if (s.type === "string" && typeof v !== "string") return `${spec.name}: "${key}" must be a string`;
    if (s.type === "number" && typeof v !== "number") return `${spec.name}: "${key}" must be a number`;
    if (s.type === "boolean" && typeof v !== "boolean") return `${spec.name}: "${key}" must be a boolean`;
    if (s.type === "url" && (typeof v !== "string" || !/^https?:\/\/\S+$/.test(v))) return `${spec.name}: "${key}" must be an http(s) URL`;
  }
  return null;
}

export type GateResult = { allowed: true } | { allowed: false; reason: string };

/** The full pre-flight for a registered tool: schema + cap. Unregistered tools are the caller's own responsibility. */
export function gateTool(name: string, args: unknown): GateResult {
  const spec = registry.get(name);
  if (!spec) return { allowed: true };
  const bad = validateArgs(spec, args);
  if (bad) return { allowed: false, reason: bad };
  if (spec.capAction) {
    const cap = checkCap(spec.capAction);
    if (!cap.allowed) return { allowed: false, reason: `${spec.name}: daily cap for ${spec.capAction.replace(/_/g, " ")} reached (${cap.used}/${cap.cap})` };
  }
  return { allowed: true };
}

/** The manifest: what an MCP client (or our own UI) needs to expose these tools. */
export function skillManifest() {
  return listTools().map((t) => ({
    name: t.name,
    description: t.description,
    args: t.args,
    risk: t.risk,
    approval: Boolean(t.approval),
    cap: t.capAction ?? null,
  }));
}

// ---------------------------------------------------------------- the catalog
registerTool({ name: "jobs.hunt", description: "Search the web for job/internship postings and shortlist them", args: { query: { type: "string", required: true, description: "what to hunt" } }, risk: "read" });
registerTool({ name: "jobs.apply", description: "Fill and (after approval) submit ONE job application in the live browser", args: { url: { type: "url", required: true, description: "posting URL" } }, risk: "identity", capAction: "apply", approval: true });
registerTool({ name: "mail.send", description: "Send one email via the connected account (approval card first)", args: { to: { type: "string", required: true }, from: { type: "string" }, body: { type: "string", description: "email body; the model drafts one when omitted" } }, risk: "identity", capAction: "send_mail", approval: true });
registerTool({ name: "mail.search", description: "Search recent inbox by sender/subject/content words", args: { query: { type: "string", required: true } }, risk: "read" });
registerTool({ name: "mail.read", description: "Read the body of one inbox message by uid", args: {}, risk: "read" });
registerTool({ name: "mail.inbox", description: "Read recent inbox subjects", args: {}, risk: "read" });
registerTool({ name: "mail.draft", description: "Draft an email with the model (never sends)", args: { to: { type: "string", required: true } }, risk: "read" });
registerTool({ name: "tracker.list", description: "List tracked applications", args: {}, risk: "read" });
registerTool({ name: "tracker.add", description: "Track one application", args: { company: { type: "string", required: true }, role: { type: "string" } }, risk: "write" });
registerTool({ name: "browser.navigate", description: "Open a URL in the live browser", args: { url: { type: "url", required: true } }, risk: "write" });
registerTool({ name: "form.fill", description: "Fill a web/Google form end-to-end: true answers from profile+memory, asks for unknowns, review card, submit + confirmation screenshot", args: { url: { type: "url", required: true, description: "form URL" } }, risk: "identity", approval: true });
registerTool({ name: "signup.google", description: "Sign up on a site with Google SSO or email+password (human takeover on OTP)", args: { site: { type: "string", required: true } }, risk: "identity", approval: true });
registerTool({ name: "web.search", description: "Keyless web search (DuckDuckGo, then Bing)", args: { query: { type: "string", required: true } }, risk: "read" });
registerTool({ name: "model.chat", description: "One model reply (the race)", args: { text: { type: "string", required: true } }, risk: "read" });
registerTool({ name: "model.draft", description: "Model-drafted text (email body etc.)", args: { text: { type: "string", required: true } }, risk: "read" });
registerTool({ name: "local.status", description: "Ollama + GPU detection and local model tier", args: {}, risk: "read" });
registerTool({ name: "linkedin.message", description: "Send a LinkedIn DM through the logged-in session (approval + daily cap)", args: { url: { type: "url", required: true }, text: { type: "string", required: true } }, risk: "identity", capAction: "linkedin_message", approval: true });
registerTool({ name: "linkedin.invite", description: "Send a LinkedIn connection invite (approval + daily cap)", args: { url: { type: "url", required: true } }, risk: "identity", capAction: "linkedin_invite", approval: true });
registerTool({ name: "drive.list", description: "List Drive files", args: {}, risk: "read" });
registerTool({ name: "drive.upload", description: "Upload a file to Drive", args: { path: { type: "string", required: true } }, risk: "write" });
registerTool({ name: "git.init", description: "git init a repo", args: { name: { type: "string", required: true } }, risk: "write" });
registerTool({ name: "git.commit", description: "git commit a path", args: { path: { type: "string", required: true }, message: { type: "string" } }, risk: "write" });
registerTool({ name: "git.push", description: "git push a path", args: { path: { type: "string", required: true }, remote: { type: "string" }, branch: { type: "string" } }, risk: "write" });
registerTool({ name: "scheduler.add", description: "Schedule a recurring or one-time command", args: { command: { type: "string", required: true, description: "e.g. 'every 2 hours search AI internships' or 'at 18:30 tracker'" } }, risk: "write" });
// Level-up tools (winops, fileops, OCR, triage, CRM): registered so `skills` shows
// the real surface and gateTool validates/caps them like the originals.
registerTool({ name: "system.info", description: "Laptop snapshot: battery, RAM, disk free, CPU, uptime", args: {}, risk: "read" });
registerTool({ name: "clipboard.read", description: "Read the text clipboard", args: {}, risk: "read" });
registerTool({ name: "clipboard.write", description: "Copy text to the clipboard", args: { length: { type: "string", description: "character count" } }, risk: "write" });
registerTool({ name: "app.launch", description: "Launch an allow-listed app (notepad, calculator, chrome...) - never an arbitrary exe", args: { app: { type: "string", required: true } }, risk: "write" });
registerTool({ name: "fs.rename", description: "Batch-rename files in a folder (approval card + undo)", args: {}, risk: "write", capAction: "rename" });
registerTool({ name: "fs.cleanup", description: "Archive old downloads into _archive/<month>/ (approval card, daily cap, undo)", args: {}, risk: "write", capAction: "cleanup" });
registerTool({ name: "fs.undo_rename", description: "Reverse the most recent rename batch", args: {}, risk: "write" });
registerTool({ name: "fs.undo_cleanup", description: "Reverse the most recent cleanup batch", args: {}, risk: "write" });
registerTool({ name: "fs.undo_entry", description: "Reverse one specific file operation by ledger timestamp", args: { ts: { type: "string", required: true } }, risk: "write" });
registerTool({ name: "drive.sync", description: "Sync a local folder to Drive", args: { path: { type: "string", required: true } }, risk: "write" });
registerTool({ name: "github.create_repo", description: "Create a GitHub repo via the connected account", args: { name: { type: "string", required: true } }, risk: "write" });
registerTool({ name: "image.ocr", description: "Extract text from an image file (local OCR)", args: { path: { type: "string", required: true } }, risk: "read" });
registerTool({ name: "screen.ocr", description: "Screenshot the screen and extract its text (local OCR)", args: {}, risk: "read" });
registerTool({ name: "linkedin.feed", description: "Read the LinkedIn feed via the logged-in session", args: {}, risk: "read" });
registerTool({ name: "mail.triage", description: "Classify recent inbox: what actually needs a reply", args: {}, risk: "read" });
registerTool({ name: "vault.list", description: "List vault entry names (never values)", args: {}, risk: "read" });

