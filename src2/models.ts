/** Live model resolution: connect-time model picking for every provider.
 *  A hardcoded model id is never trusted on its own:
 *   1. fetch the provider's live /models list with the user's own key
 *   2. order candidates: preference-list entries present in the live list first,
 *      then the rest of the docs-verified fallback list
 *   3. verify each candidate with a tiny completion - first success wins and is saved.
 *  The race reads the saved id via currentModel(), so a retired model is fixed once at connect. */
import { getSetting, setSetting } from "./db.js";
import { OpenAiCompatibleProvider } from "../src/providers/openai.js";

export type ProviderId = "groq" | "openrouter" | "cerebras" | "github-models" | "gemini";

type Spec = {
  id: ProviderId;
  label: string;
  baseUrl: () => string;      // OpenAI-compatible base; Gemini: the v1beta root
  keySetting: string;
  modelSetting: string;
  preferences: string[];      // best-first fallback list (provider docs, verified Oct 2026)
  freeOnly?: boolean;         // restrict live picks to free-tier ids (OpenRouter ":free")
  gemini?: boolean;
};

export const PROVIDERS: Record<ProviderId, Spec> = {
  groq: {
    id: "groq", label: "Groq",
    baseUrl: () => process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
    keySetting: "groq_api_key", modelSetting: "groq_model",
    // console.groq.com/docs/models (production chat models)
    preferences: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "qwen/qwen3.8-27b", "llama-3.1-8b-instant", "openai/gpt-oss-20b"],
  },
  openrouter: {
    id: "openrouter", label: "OpenRouter",
    baseUrl: () => process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    keySetting: "openrouter_api_key", modelSetting: "openrouter_model",
    // openrouter.ai/api/v1/models - ids ending :free are the zero-cost tier
    preferences: ["meta-llama/llama-3.3-70b-instruct:free", "google/gemma-4-31b-it:free", "google/gemma-4-26b-a4b-it:free", "nvidia/nemotron-3-super-120b-a12b:free", "minimax/minimax-m3.1-flash:free"],
    freeOnly: true,
  },
  cerebras: {
    id: "cerebras", label: "Cerebras",
    baseUrl: () => process.env.CEREBRAS_BASE_URL || "https://api.cerebras.ai/v1",
    keySetting: "cerebras_api_key", modelSetting: "cerebras_model",
    // inference-docs.cerebras.ai/models
    preferences: ["llama-3.3-70b", "gpt-oss-120b", "qwen-3.8-27b", "llama3.1-8b", "qwen-3-32b", "zai-glm-4.6"],
  },
  "github-models": {
    id: "github-models", label: "GitHub Models",
    baseUrl: () => process.env.GITHUB_MODELS_BASE_URL || "https://models.github.ai/inference",
    keySetting: "github_models_key", modelSetting: "github_models_model",
    // github.com/marketplace?type=models / docs.github.com/github-models
    preferences: ["openai/gpt-4o-mini", "openai/gpt-4.1-mini", "openai/gpt-4.1", "openai/gpt-4o", "meta/llama-3.3-70b-instruct", "deepseek/deepseek-v3-0324"],
  },
  gemini: {
    id: "gemini", label: "Gemini",
    baseUrl: () => process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta",
    keySetting: "model_api_key", modelSetting: "model",
    // ai.google.dev/gemini-api/docs/models - free tier
    preferences: ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"],
    gemini: true,
  },
};

/** The provider's own live model list, or null when the listing endpoint can't be read. */
export async function listLiveModels(spec: Spec, key: string): Promise<string[] | null> {
  try {
    if (spec.gemini) {
      const res = await fetch(`${spec.baseUrl()}/models?key=${encodeURIComponent(key)}&pageSize=200`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const j = (await res.json()) as any;
      return (j.models || [])
        .filter((m: any) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m: any) => String(m.name || "").replace(/^models\//, ""))
        .filter(Boolean);
    }
    const res = await fetch(`${spec.baseUrl()}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as any;
    return (j.data || []).map((m: any) => String(m.id || "")).filter(Boolean);
  } catch {
    return null;
  }
}

export type ResolvedModel = { model: string; source: "live" | "fallback"; tried: string[] };

/** Pick and verify the model for a provider. Saves the winner into settings. */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function resolveModel(id: ProviderId, key?: string): Promise<ResolvedModel> {
  const spec = PROVIDERS[id];
  const k = key ?? getSetting(spec.keySetting) ?? "";
  if (!k) throw new Error(`${spec.label}: no API key stored - paste it into the connect card`);
  let live = await listLiveModels(spec, k);
  if (live && spec.freeOnly) live = live.filter((m) => m.endsWith(":free"));
  const candidates = live
    ? [...spec.preferences.filter((p) => live!.includes(p)), ...spec.preferences.filter((p) => !live!.includes(p))]
    : spec.preferences;
  const seen = new Set<string>();
  const tried: string[] = [];
  const VALIDATE_TIMEOUT_MS = 20_000;
  for (const m of candidates) {
    if (seen.has(m)) continue;
    seen.add(m);
    tried.push(m);
    try {
      if (spec.gemini) {
        const { validateGeminiConnection } = await import("../src/providers/gemini.js");
        await withTimeout(validateGeminiConnection(m, k, spec.baseUrl()), VALIDATE_TIMEOUT_MS, `${spec.label} ${m} validation`);
      } else {
        // No timeout here previously meant a provider that accepts the connection but
        // never answers (a known overloaded-free-tier failure mode) could hang
        // `connect <provider>` forever.
        await withTimeout(
          new OpenAiCompatibleProvider(spec.baseUrl(), m, k).chat([{ role: "user", content: "ping" }], { maxTokens: 4 }),
          VALIDATE_TIMEOUT_MS,
          `${spec.label} ${m} validation`,
        );
      }
      setSetting(spec.modelSetting, m);
      return { model: m, source: live?.includes(m) ? "live" : "fallback", tried };
    } catch { /* dead, inaccessible, or timed-out model - try the next candidate */ }
  }
  throw new Error(`${spec.label}: none of the candidate models answered (tried: ${tried.join(", ")}). Check the key and the provider's status page.`);
}

/** The model the race should use right now: the resolved setting, else the best documented default. */
export function currentModel(id: ProviderId): string {
  const spec = PROVIDERS[id];
  return getSetting(spec.modelSetting) || spec.preferences[0];
}
