/** MCP server: exposes the tool registry to MCP clients over JSON-RPC 2.0 at POST /mcp.
 *  Streamable-HTTP shape, stateless (no session ids, no SSE stream - POST only).
 *  Same gates as the chat path, by construction:
 *   - schema + daily-cap pre-flight via gateTool (src2/skills.ts) on every call
 *   - approval-gated tools (identity/money: mail.send, jobs.apply, signup.google, linkedin.*)
 *     run the REAL chat flow - the same approval card appears in the owner's UI and the
 *     call completes only when the owner approves, rejects, or the card expires.
 *  Every call is traced (span + bus events) exactly like a chat-triggered tool call.
 *  Auth: when APP_PASSWORD is set, the session cookie OR `Authorization: Bearer <APP_PASSWORD>`. */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { emit, onEvent } from "./bus.js";
import { gateTool, listTools, getTool, type ToolSpec } from "./skills.js";
import { startSpan, endSpan } from "./trace.js";
import { authEnabled, isAuthed } from "./auth.js";

const PROTOCOL_VERSION = "2025-03-26";

/** Tools whose execution must pass through the chat flow (approval cards, human takeover). */
const s = (v: unknown) => String(v ?? "");
const CHAT_FLOW = new Map<string, (args: Record<string, unknown>) => string>([
  ["mail.send", (a) => a.body ? `send mail to ${s(a.to)}${a.from ? ` from ${s(a.from)}` : ""}: ${s(a.body)}` : `send mail to ${s(a.to)}${a.from ? ` from ${s(a.from)}` : ""}`],
  ["jobs.apply", (a) => `apply to ${s(a.url)}`],
  ["signup.google", (a) => `sign up on ${s(a.site)} with google`],
  ["linkedin.message", (a) => `linkedin message ${s(a.url)}: ${s(a.text)}`],
  ["linkedin.invite", (a) => `connect with ${s(a.url)} on linkedin`],
]);

function inputSchema(spec: ToolSpec) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [k, s] of Object.entries(spec.args)) {
    properties[k] = {
      type: s.type === "url" ? "string" : s.type,
      ...(s.type === "url" ? { format: "uri" } : {}),
      ...(s.description ? { description: s.description } : {}),
    };
    if (s.required) required.push(k);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

// serialize chat-flow executions so run-id capture below is deterministic (single-user app)
let flowChain: Promise<unknown> = Promise.resolve();
function runChatFlow(text: string): Promise<string> {
  const run = flowChain.then(async () => {
    let runId = "";
    const texts: string[] = [];
    const off = onEvent((e) => {
      if (!runId && e.run_id) runId = e.run_id;
      if (runId && e.run_id === runId && e.kind === "text" && e.role === "agent") texts.push(String(e.text ?? ""));
    });
    try {
      const { handleUserMessage } = await import("./agent2.js");
      await handleUserMessage(text);
    } finally {
      off();
    }
    return texts.join("\n\n") || "Done.";
  });
  flowChain = run.catch(() => {});
  return run;
}

/** Direct executors for read/write tools (no approval gate). Mirrors the chat handlers. */
async function direct(name: string, a: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "web.search": {
      const { webSearch } = await import("./search.js");
      const rs = await webSearch(String(a.query));
      return rs.length ? rs.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n") : `No results for "${a.query}".`;
    }
    case "jobs.hunt": {
      const { webSearch } = await import("./search.js");
      const { listApplications, addApplication } = await import("./tracker.js");
      const rs = await webSearch(String(a.query));
      const tracked = new Set(listApplications().map((x) => x.url).filter(Boolean));
      const host = (u: string) => { try { return new URL(u).hostname; } catch { return u; } };
      for (const r of rs) if (r.url && !tracked.has(r.url)) addApplication({ company: host(r.url), role: r.title.slice(0, 80), portal: host(r.url), url: r.url, status: "Scouted" });
      return rs.length ? rs.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${tracked.has(r.url) ? " (already tracked)" : ""}`).join("\n") : `No results for "${a.query}".`;
    }
    case "tracker.list": {
      const { listApplications } = await import("./tracker.js");
      const apps = listApplications();
      return apps.length ? apps.map((x) => `- ${x.company}${x.role ? ` - ${x.role}` : ""} [${x.status}]`).join("\n") : "No applications tracked yet.";
    }
    case "tracker.add": {
      const { addApplication } = await import("./tracker.js");
      const app = addApplication({ company: String(a.company), role: a.role ? String(a.role) : undefined });
      return `Tracked: ${app.company}${app.role ? ` - ${app.role}` : ""} (${app.status}).`;
    }
    case "mail.inbox": {
      const { mailConfigured, listInbox } = await import("./mail.js");
      if (!mailConfigured()) return "Email is not connected yet (connect email).";
      const msgs = await listInbox(15);
      return msgs.length ? msgs.map((m: any) => `- ${m.from || ""}: ${m.subject || ""}`).join("\n") : "Inbox zero.";
    }
    case "mail.draft":
    case "model.chat": {
      const { modelRace } = await import("./agent2.js");
      const prompt = name === "mail.draft"
        ? `Draft a short professional email to ${a.to}. Return a Subject: line, then the body.`
        : String(a.text);
      return modelRace(`mcp-${randomBytes(4).toString("hex")}`, [{ role: "user", content: prompt }]);
    }
    case "local.status": {
      const { localStatus } = await import("./local.js");
      return JSON.stringify(await localStatus(), null, 2);
    }
    case "browser.navigate": {
      const br = await import("./browser.js");
      return `Now on: ${await br.navigate(String(a.url))}`;
    }
    case "drive.list": {
      const { driveConfigured, listDriveFiles } = await import("./drive.js");
      if (!driveConfigured()) return "Drive is not connected yet (connect drive).";
      const files = await listDriveFiles(30);
      return files.length ? files.map((f: any) => `- ${f.name} ${f.webViewLink || ""}`).join("\n") : "Drive is empty.";
    }
    case "drive.upload": {
      const { uploadToDrive } = await import("./drive.js");
      const f = await uploadToDrive(String(a.path));
      return `Uploaded: ${(f as any).name} ${(f as any).webViewLink || ""}`.trim();
    }
    case "git.init": {
      const { initRepo } = await import("./git.js");
      const name = String(a.name).replace(/[^\w.-]/g, "-");
      const r = await initRepo(`${process.env.HOME || "."}/repos/${name}`, name);
      return `Repo ${r.created ? "created" : "already existed"} at ${r.path}.`;
    }
    case "git.commit": {
      const { commitAll } = await import("./git.js");
      const r = await commitAll(String(a.path), String(a.message || "agent: checkpoint"));
      return r ? `Committed: ${r}` : "Nothing to commit - working tree clean.";
    }
    case "git.push": {
      const { push } = await import("./git.js");
      return push(String(a.path), String(a.remote || "origin"), String(a.branch || "main"));
    }
    case "scheduler.add": {
      const { parseSchedule, addJob } = await import("./scheduler.js");
      const spec = parseSchedule(String(a.command || "").toLowerCase());
      if (!spec) throw new Error(`could not parse a schedule from "${a.command}" - use forms like "every 2 hours search X" or "at 18:30 tracker"`);
      const job = addJob(spec.command, spec.nextRun, spec.intervalMin);
      return `Scheduled "${spec.command}" ${spec.intervalMin ? `every ${spec.intervalMin} min` : "once"} - first run ${new Date(spec.nextRun).toLocaleString()} (job ${job.id}).`;
    }
    default:
      throw new Error(`${name} has no MCP executor`);
  }
}

/** One observable tool execution: gate -> span + bus events -> executor. Identical shape to chat's toolCall. */
async function exec(runId: string, name: string, args: Record<string, unknown>): Promise<string> {
  const gate = gateTool(name, args);
  if (!gate.allowed) {
    emit({ ts: Date.now(), run_id: runId, kind: "tool_result", tool: name, input: args, error: gate.reason, duration_ms: 0, state: "error" });
    throw new Error(gate.reason);
  }
  const spanId = startSpan(runId, name, null, { input: args, via: "mcp" });
  const started = Date.now();
  emit({ ts: started, run_id: runId, kind: "tool_call", tool: name, input: args, state: "running" });
  try {
    const out = CHAT_FLOW.has(name) ? await runChatFlow(CHAT_FLOW.get(name)!(args)) : await direct(name, args);
    endSpan(spanId, "ok");
    emit({ ts: Date.now(), run_id: runId, kind: "tool_result", tool: name, input: args, result: { text: out.slice(0, 2000) }, duration_ms: Date.now() - started, state: "ok" });
    return out;
  } catch (e: any) {
    endSpan(spanId, "error", { error: String(e?.message || e).slice(0, 500) });
    emit({ ts: Date.now(), run_id: runId, kind: "tool_result", tool: name, input: args, error: String(e?.message || e), duration_ms: Date.now() - started, state: "error" });
    throw e;
  }
}

export function registerMcp(app: FastifyInstance) {
  app.get("/mcp", async (_req, reply) =>
    reply.code(405).header("allow", "POST").send({ error: "POST JSON-RPC 2.0 here; no SSE stream in this build" }));

  app.post("/mcp", async (req, reply) => {
    if (authEnabled() && !isAuthed(req)) {
      const bearer = String(req.headers.authorization || "");
      if (bearer !== `Bearer ${process.env.APP_PASSWORD}`) {
        return reply.code(401).send({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "authentication required: owner session or Authorization: Bearer <APP_PASSWORD>" } });
      }
    }
    const msg = req.body as any;
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return reply.code(400).send({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "invalid JSON-RPC 2.0 request" } });
    }
    // notifications (no id): acknowledge, never respond with a result
    if (msg.id === undefined || msg.id === null) return reply.code(202).send();

    const id = msg.id;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

    switch (msg.method) {
      case "initialize":
        return ok({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "personal-agent", version: "3.0.0" },
          instructions: "Personal Agent tool registry. Tools marked owner-approval surface a card in the owner's UI and complete only after the owner approves. Daily caps are enforced before execution.",
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({
          tools: listTools().map((t) => ({
            name: t.name,
            description: `${t.description} [risk: ${t.risk}${t.approval ? ", owner-approval" : ""}${t.capAction ? `, daily cap: ${t.capAction}` : ""}]`,
            inputSchema: inputSchema(t),
          })),
        });
      case "tools/call": {
        const name = String(msg.params?.name || "");
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        if (!getTool(name)) return fail(-32602, `unknown tool: ${name}`);
        const runId = `mcp-${randomBytes(4).toString("hex")}`;
        try {
          const text = await exec(runId, name, args);
          return ok({ content: [{ type: "text", text }], isError: false });
        } catch (e: any) {
          return ok({ content: [{ type: "text", text: String(e?.message || e) }], isError: true });
        }
      }
      default:
        return fail(-32601, `method not found: ${msg.method}`);
    }
  });
}
