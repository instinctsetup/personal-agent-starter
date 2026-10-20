/** Local SLMs via Ollama: detect the server + GPU, pick models that honestly fit the VRAM,
 *  chat through the OpenAI-compatible endpoint, and feed the race. Free, private, offline-capable.
 *  Sizing rules (4GB card): budget ~3GB usable (Windows+Chrome hold 0.5-1GB); never pull a model
 *  whose weights leave no room for KV cache; a fully-resident 3B beats a partly-offloaded 8B. */
import { getSetting, setSetting } from "./db.js";
import { execFile } from "node:child_process";

export const OLLAMA_BASE = () => (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");

export type LocalTier = { chat: string; router: string; note: string };

/** VRAM (MB) -> honest model picks (weights + KV must fit together). */
export function pickModels(vramMb: number): LocalTier | null {
  if (vramMb >= 12288) return { chat: "qwen3:8b", router: "gemma3:1b", note: "12GB+ card: 8B chat model fits comfortably." };
  if (vramMb >= 8192) return { chat: "llama3.1:8b", router: "gemma3:1b", note: "8GB card: 8B class with headroom for context." };
  if (vramMb >= 6144) return { chat: "qwen3.5:4b", router: "gemma3:1b", note: "6GB card: the 4B tier fits; 8B would spill." };
  if (vramMb >= 3500) return { chat: "qwen3.5:2b", router: "gemma3:1b", note: "4GB card: 2B chat + 1B router, both fully GPU-resident. 4B models would spill to slow system RAM - don't let anyone talk you into one." };
  if (vramMb >= 2048) return { chat: "llama3.2:1b", router: "llama3.2:1b", note: "2GB card: 1B models only - good for routing and short answers, not deep reasoning." };
  return null; // below 2GB: not worth it - the cloud race carries the load
}

export function localEnabled(): boolean {
  return getSetting("local_enabled") === "1";
}
export function setLocalEnabled(on: boolean) {
  setSetting("local_enabled", on ? "1" : "0");
}

export async function ollamaUp(timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE()}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function pulledModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE()}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const j = (await res.json()) as any;
    return (j.models || []).map((m: any) => String(m.name || m.model || ""));
  } catch {
    return [];
  }
}

/** VRAM in MB from nvidia-smi; null when no NVIDIA GPU / driver. Test override: OLLAMA_FAKE_VRAM_MB. */
export function detectVramMb(): Promise<number | null> {
  if (process.env.OLLAMA_FAKE_VRAM_MB) return Promise.resolve(Number(process.env.OLLAMA_FAKE_VRAM_MB));
  return new Promise((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const n = parseInt(stdout.trim().split("\n")[0], 10);
      resolve(Number.isFinite(n) ? n : null);
    });
  });
}

export type LocalStatus = {
  enabled: boolean; ollama: boolean; vramMb: number | null; tier: LocalTier | null;
  pulled: string[]; ready: string[]; missing: string[];
};

export async function localStatus(): Promise<LocalStatus> {
  const [up, vramMb, pulled] = await Promise.all([ollamaUp(), detectVramMb(), pulledModels()]);
  const tier = vramMb ? pickModels(vramMb) : null;
  const want = tier ? [tier.chat, tier.router] : [];
  const ready = want.filter((w) => pulled.some((p) => p === w || p.startsWith(`${w}:`)));
  return { enabled: localEnabled(), ollama: up, vramMb, tier, pulled, ready, missing: want.filter((w) => !ready.includes(w)) };
}

/** Chat completion through Ollama's OpenAI-compatible endpoint. Throws on failure - callers fall back to the race. */
export async function ollamaChat(model: string, messages: { role: string; content: string }[], timeoutMs = 60_000): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE()}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as any;
  const text = j.choices?.[0]?.message?.content ?? "";
  if (!String(text).trim()) throw new Error("Ollama returned an empty reply");
  return String(text);
}

/** Pull a model, reporting progress. Long (hundreds of MB) - callers run it with visible status. */
export async function pullModel(model: string, onProgress: (pct: number, detail: string) => void): Promise<void> {
  const res = await fetch(`${OLLAMA_BASE()}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: model, stream: true }),
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!res.ok || !res.body) throw new Error(`pull failed: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j.error) throw new Error(String(j.error));
        const pct = j.total ? Math.round((100 * (j.completed || 0)) / j.total) : 0;
        onProgress(pct, String(j.status || ""));
      } catch (e: any) {
        if (e?.message && !/JSON/.test(e.message)) throw e;
      }
    }
  }
}
