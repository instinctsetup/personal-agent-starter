/** v2 HTTP+WS app: JSON API, event stream, static UI. */
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import type { WebSocket } from "ws";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { db, getSetting, setSetting } from "./db.js";
import { onEvent } from "./bus.js";
import { handleUserMessage, handleSetupSubmit } from "./agent2.js";
import { resolveApproval, getApproval } from "./approvals.js";
import { listApplications, addApplication, updateApplication, deleteApplication, trackerCsv } from "./tracker.js";
import { listCredentials } from "./vault.js";
import { listJobs, setJobEnabled, deleteJob } from "./scheduler.js";
import { listInbox, mailConfigured } from "./mail.js";
import { listSignups } from "./signup.js";
import { handleSlackEvent, verifySlackSignature, startTelegramBridge } from "./bridge.js";
import { registerAuth, isAuthed, authEnabled } from "./auth.js";
import { getBoard, boardData, renderBoardPage } from "./boards.js";
import { registerMcp } from "./mcp.js";
import { getCredential } from "./vault.js";

export async function buildApp() {
  const app = Fastify({ logger: false });
  registerAuth(app);
  registerMcp(app);
  await app.register(fastifyWebsocket);
  const br = await import("./browser.js");

  // screencast subscribers + lazy cast lifecycle (streams only while someone watches)
  const castSubs = new Set<WebSocket>();
  let castStarting: Promise<void> | null = null;
  const ensureCast = () => {
    if (br.isScreencasting()) return Promise.resolve();
    if (castStarting) return castStarting;
    castStarting = br.startScreencast((buf) => {
      for (const ws of castSubs) {
        try {
          if ((ws as any).bufferedAmount > 512 * 1024) { br.noteSlowConsumer(); continue; } // drop frames for a slow client
          ws.send(buf);
        } catch { /* dropped */ }
      }
    }).finally(() => { castStarting = null; });
    return castStarting;
  };
  const dropCastSub = (ws: WebSocket) => {
    castSubs.delete(ws);
    if (castSubs.size === 0) br.stopScreencast();
  };

  const clients = new Set<WebSocket>();
  onEvent((e) => {
    const data = JSON.stringify(e);
    for (const ws of clients) {
      try { ws.send(data); } catch { /* dropped */ }
    }
  });

  app.get("/ws", { websocket: true }, (socket) => {
    clients.add(socket);
    socket.on("close", () => { clients.delete(socket); dropCastSub(socket); });
    socket.on("message", async (raw: Buffer | string) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      try {
        if (msg?.type === "screencast") {
          if (msg.on) { castSubs.add(socket); await ensureCast(); }
          else dropCastSub(socket);
        } else if (msg?.type === "click") await br.clickAt(Number(msg.x), Number(msg.y));
        else if (msg?.type === "type") await br.typeText(String(msg.text ?? ""));
        else if (msg?.type === "key") await br.pressKey(String(msg.key ?? "Enter"));
        else if (msg?.type === "scroll") await br.scrollBy(Number(msg.dx) || 0, Number(msg.dy) || 0);
        else if (msg?.type === "back") await br.goBack();
        else if (msg?.type === "forward") await br.goForward();
        else if (msg?.type === "navigate" && msg.url) await br.navigate(String(msg.url));
      } catch { /* a bad input message must not kill the socket */ }
    });
  });

  app.post("/api/chat", async (req) => {
    const { text } = req.body as { text: string };
    if (!text?.trim()) return { error: "empty message" };
    void handleUserMessage(text.trim(), false, "web"); // events stream over WS
    return { ok: true };
  });

  app.post("/api/setup", async (req) => {
    const { service, values } = req.body as { service: string; values: Record<string, string> };
    const status = await handleSetupSubmit(service, values || {});
    return { ok: status === "ok", status };
  });

  app.post("/api/approvals/:id", async (req) => {
    const { id } = req.params as { id: string };
    const { decision, payload } = req.body as { decision: "approved" | "rejected"; payload?: Record<string, unknown> };
    const ok = resolveApproval(id, decision, payload);
    return { ok, approval: getApproval(id) };
  });

  app.get("/api/history", async () => {
    const rows = db.prepare("SELECT ts, role, kind, body, run_id FROM messages ORDER BY id DESC LIMIT 200").all() as any[];
    return { messages: rows.reverse().map((r) => ({ ...r, body: JSON.parse(r.body) })) };
  });

  app.get("/api/tracker", async () => ({ applications: listApplications() }));
  app.post("/api/tracker", async (req) => ({ application: addApplication(req.body as any) }));
  app.patch("/api/tracker/:id", async (req) => {
    const ok = updateApplication(Number((req.params as any).id), req.body as any);
    return { ok };
  });
  app.delete("/api/tracker/:id", async (req) => ({ ok: deleteApplication(Number((req.params as any).id)) }));
  app.get("/api/tracker.csv", async (_req, reply) => {
    reply.header("content-type", "text/csv").header("content-disposition", "attachment; filename=tracker.csv");
    return trackerCsv();
  });

  app.get("/api/vault", async () => ({ entries: listCredentials() }));
  app.get("/api/traces", async () => {
    const { recentRuns } = await import("./trace.js");
    return { runs: recentRuns(20) };
  });
  app.get("/api/traces/:runId", async (req) => {
    const { spanTree } = await import("./trace.js");
    return { spans: spanTree((req.params as any).runId) };
  });
  app.get("/api/skills", async () => {
    const { skillManifest } = await import("./skills.js");
    return { tools: skillManifest() };
  });
  app.get("/api/jobs", async () => ({ jobs: listJobs() }));
  app.get("/api/signups", async () => ({ signups: listSignups() }));
  app.get("/api/drive", async () => {
    const { driveConfigured, listDriveFiles } = await import("./drive.js");
    if (!driveConfigured()) return { configured: false, files: [] };
    try { return { configured: true, files: await listDriveFiles(30) }; }
    catch (e: any) { return { configured: true, error: String(e?.message || e), files: [] }; }
  });
  app.post("/api/slack/events", async (req, reply) => {
    const raw = JSON.stringify(req.body);
    const secret = getCredential("slack-signing")?.secret;
    if (secret) {
      const ts = req.headers["x-slack-request-timestamp"] as string;
      const sig = req.headers["x-slack-signature"] as string;
      if (!verifySlackSignature(secret, ts || "", raw, sig || "")) return reply.code(401).send({ error: "bad signature" });
    }
    return handleSlackEvent(req.body);
  });
  app.post("/api/bridge/telegram/start", async () => ({ started: await startTelegramBridge() }));
  app.get("/api/mail/inbox", async () => {
    if (!mailConfigured()) return { configured: false, messages: [] };
    try { return { configured: true, messages: await listInbox() }; }
    catch (e: any) { return { configured: true, error: String(e?.message || e), messages: [] }; }
  });
  app.post("/api/jobs/:id/toggle", async (req) => {
    const { enabled } = req.body as { enabled: boolean };
    return { ok: setJobEnabled((req.params as any).id, enabled) };
  });
  app.delete("/api/jobs/:id", async (req) => ({ ok: deleteJob((req.params as any).id) }));
  app.get("/api/version", async () => (await import("./version.js")).APP_VERSION);

  app.get("/api/settings", async () => ({
    model: getSetting("model") || (getSetting("model_provider") === "gemini" ? "gemini-3.8-flash" : "gpt-4o-mini"),
    model_provider: getSetting("model_provider") || "openai",
    model_base_url: getSetting("model_base_url") || "",
    model_key_set: Boolean(getSetting("model_api_key")),
    email_configured: Boolean(getSetting("imap_host")),
    email_user: getSetting("email_user") || "",
    linkedin_on: getSetting("linkedin_enabled") === "1",
  }));
  app.post("/api/settings", async (req) => {
    for (const [k, v] of Object.entries(req.body as Record<string, string>)) setSetting(k, v);
    return { ok: true };
  });


  // --- live browser ---
  app.post("/api/browser/navigate", async (req) => {
    const { url } = req.body as { url: string };
    const final = await br.navigate(url);
    return { url: final };
  });
  app.get("/api/browser/screenshot", async (_req, reply) => {
    const buf = await br.screenshot();
    reply.header("content-type", "image/jpeg").header("cache-control", "no-store");
    return reply.send(buf);
  });
  app.post("/api/browser/click", async (req) => {
    const { x, y } = req.body as { x: number; y: number };
    await br.clickAt(x, y);
    return { ok: true };
  });
  app.post("/api/browser/type", async (req) => {
    const { text } = req.body as { text: string };
    await br.typeText(text);
    return { ok: true };
  });
  app.post("/api/browser/key", async (req) => {
    const { key } = req.body as { key: string };
    await br.pressKey(key);
    return { ok: true };
  });
  app.post("/api/browser/scroll", async (req) => {
    const { dx, dy } = req.body as { dx?: number; dy?: number };
    await br.scrollBy(Number(dx) || 0, Number(dy) || 0);
    return { ok: true };
  });
  app.post("/api/browser/back", async () => ({ ok: true, url: await br.goBack() }));
  app.post("/api/browser/forward", async () => ({ ok: true, url: await br.goForward() }));
  app.get("/api/browser/state", async () => ({
    url: await br.currentUrl(),
    user_control: br.isUserControlling(),
    challenge: await br.detectChallenge(),
  }));
  app.post("/api/browser/control", async (req) => {
    const { user } = req.body as { user: boolean };
    br.setUserControl(Boolean(user));
    return { ok: true, user_control: br.isUserControlling() };
  });
  app.post("/api/browser/close", async () => { await br.closeBrowser(); return { ok: true }; });


  // --- boards: live shareable dashboards (owner session or ?k= share token; auth checked here, not in the /api hook) ---
  const boardAllowed = (req: any, b: { share_token: string }) =>
    !authEnabled() || isAuthed(req) || String((req.query as any)?.k || "") === b.share_token;
  app.get("/boards/:id.json", async (req, reply) => {
    const b = getBoard((req.params as any).id);
    if (!b) return reply.code(404).send({ error: "not found" });
    if (!boardAllowed(req, b)) return reply.code(401).send({ error: "authentication required" });
    return { id: b.id, title: b.title, ...(await boardData(b.kind) as any) };
  });
  app.get("/boards/:id", async (req, reply) => {
    const b = getBoard((req.params as any).id);
    if (!b) return reply.code(404).type("text/html").send("<h1>Board not found</h1>");
    if (!boardAllowed(req, b)) return reply.code(401).type("text/html").send("<h1>This board link is not valid.</h1>");
    return reply.type("text/html").send(renderBoardPage(b, String((req.query as any)?.k || "")));
  });

  const uiDir = join(process.cwd(), "web-v2", "dist");
  if (existsSync(uiDir)) {
    await app.register(fastifyStatic, { root: uiDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url === "/ws") return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
