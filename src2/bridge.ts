/** Telegram + Slack bridges: route incoming messages into the chat agent and replies back out.
 *  Telegram: long-polling with a bot token from the vault ("telegram"). Slack: Events API over /api/slack/events. */
import { emit, onEvent } from "./bus.js";
import { getCredential } from "./vault.js";
import { handleUserMessage } from "./agent2.js";
import { createHmac } from "node:crypto";

// ---- outbound fan-out: every agent text/status event goes to active bridge targets ----
type Target = { kind: "telegram" | "slack"; chat: string };
const activeTargets = new Set<Target>();
export function bridgeTargets(): Target[] { return [...activeTargets]; }

async function sendTelegram(chatId: string, text: string): Promise<boolean> {
  const tok = getCredential("telegram")?.secret;
  if (!tok) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
    });
    return res.ok;
  } catch { return false; }
}

async function sendSlack(channel: string, text: string): Promise<boolean> {
  const tok = getCredential("slack")?.secret;
  if (!tok) return false;
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
      body: JSON.stringify({ channel, text: text.slice(0, 4000) }),
    });
    const d = await res.json() as any;
    return Boolean(d.ok);
  } catch { return false; }
}

let fanoutStarted = false;
export function startBridgeFanout(): void {
  if (fanoutStarted) return;
  fanoutStarted = true;
  onEvent((e) => {
    if (e.kind !== "text" || e.role !== "assistant") return;
    for (const t of activeTargets) {
      const text = typeof e.text === "string" ? e.text : "";
      if (!text) continue;
      if (t.kind === "telegram") void sendTelegram(t.chat, text);
      else void sendSlack(t.chat, text);
    }
  });
}

// ---- Telegram long-poll ----
let tgPolling = false;
export async function startTelegramBridge(pollMs = 3000): Promise<boolean> {
  const tok = getCredential("telegram")?.secret;
  if (!tok || tgPolling) return false;
  tgPolling = true;
  startBridgeFanout();
  let offset = 0;
  const poll = async () => {
    while (tgPolling) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${tok}/getUpdates?offset=${offset}&timeout=25`);
        const d = await res.json() as any;
        for (const u of d.result || []) {
          offset = u.update_id + 1;
          const msg = u.message;
          if (!msg?.text || msg.from?.is_bot) continue;
          const chatId = String(msg.chat.id);
          activeTargets.add({ kind: "telegram", chat: chatId });
          void handleUserMessage(msg.text);
        }
      } catch { /* network hiccup */ }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };
  void poll();
  return true;
}
export function stopTelegramBridge(): void { tgPolling = false; }

// ---- Slack Events API ----
export function verifySlackSignature(signingSecret: string, timestamp: string, body: string, signature: string): boolean {
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = "v0=" + createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex");
  return expected.length === signature.length &&
    createHmac("sha256", "x").update(expected).digest("hex") === createHmac("sha256", "x").update(signature).digest("hex");
}

/** Handle one Slack Events API payload. Returns the HTTP response body. */
export function handleSlackEvent(payload: any): { challenge?: string; ok?: boolean } {
  if (payload.type === "url_verification") return { challenge: payload.challenge };
  const ev = payload.event;
  if (ev?.type === "message" && ev.text && !ev.bot_id && !ev.subtype) {
    activeTargets.add({ kind: "slack", chat: ev.channel });
    startBridgeFanout();
    void handleUserMessage(ev.text);
  }
  return { ok: true };
}
