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

export async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);

  const clients = new Set<WebSocket>();
  onEvent((e) => {
    const data = JSON.stringify(e);
    for (const ws of clients) {
      try { ws.send(data); } catch { /* dropped */ }
    }
  });

  app.get("/ws", { websocket: true }, (socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
  });

  app.post("/api/chat", async (req) => {
    const { text } = req.body as { text: string };
    if (!text?.trim()) return { error: "empty message" };
    void handleUserMessage(text.trim()); // events stream over WS
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
  app.get("/api/settings", async () => ({
    model: getSetting("model") || "gpt-4o-mini",
    model_base_url: getSetting("model_base_url") || "",
    model_key_set: Boolean(getSetting("model_api_key")),
    email_configured: Boolean(getSetting("imap_host")),
  }));
  app.post("/api/settings", async (req) => {
    for (const [k, v] of Object.entries(req.body as Record<string, string>)) setSetting(k, v);
    return { ok: true };
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
