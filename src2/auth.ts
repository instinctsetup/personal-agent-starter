/** Optional password gate for the control center. Off unless APP_PASSWORD is set (local stays open, cloud deploys set it). */
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getSetting, setSetting } from "./db.js";

const COOKIE = "pa_session";

export function authEnabled() {
  return Boolean(process.env.APP_PASSWORD);
}

function sessionSalt() {
  let salt = getSetting("auth_salt");
  if (!salt) {
    salt = randomBytes(16).toString("hex");
    setSetting("auth_salt", salt);
  }
  return salt;
}

export function expectedToken() {
  return createHash("sha256").update(`personal-agent:${process.env.APP_PASSWORD}:${sessionSalt()}`).digest("hex");
}

function cookieToken(req: FastifyRequest) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return "";
}

function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function isAuthed(req: FastifyRequest) {
  const t = cookieToken(req);
  return Boolean(t) && safeEqual(t, expectedToken());
}

/** Public paths: the login endpoints, slack webhooks (own HMAC check), and the static UI shell (no secrets in the bundle). */
export function isPublicPath(url: string) {
  const path = url.split("?")[0];
  if (path === "/api/login" || path === "/api/auth/status") return true;
  if (path === "/api/slack/events") return true;
  return !path.startsWith("/api/") && path !== "/ws";
}

export function registerAuth(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    if (!authEnabled() || isPublicPath(req.url)) return;
    if (!isAuthed(req)) return reply.code(401).send({ error: "authentication required" });
  });

  app.post("/api/login", async (req, reply) => {
    if (!authEnabled()) return { ok: true, enabled: false };
    const { password } = (req.body || {}) as { password?: string };
    if (!password || !safeEqual(String(password), String(process.env.APP_PASSWORD))) {
      return reply.code(401).send({ ok: false, error: "wrong password" });
    }
    const secure = String(req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "";
    reply.header("set-cookie", `${COOKIE}=${expectedToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
    return { ok: true };
  });

  app.post("/api/logout", async (_req, reply) => {
    reply.header("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  });

  app.get("/api/auth/status", async (req) => ({
    enabled: authEnabled(),
    authed: authEnabled() ? isAuthed(req) : true,
  }));
}
