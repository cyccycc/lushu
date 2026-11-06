import type { LlmEnv } from "@lushu/llm";

const DEFAULT_BASE = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";

function cleanBase(value: string | null): string {
  const raw = (value || DEFAULT_BASE).trim();
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return DEFAULT_BASE;
    return url.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_BASE;
  }
}

/**
 * The model key is read from this request only.
 * Do not write it to disk, do not log the header, and do not fall back to LLM_API_KEY.
 */
export function llmEnvFromRequest(request: Request): LlmEnv | null {
  const apiKey = request.headers.get("x-lushu-llm-key")?.trim() ?? "";
  if (!apiKey || apiKey.length > 400) return null;
  const model = (request.headers.get("x-lushu-llm-model") || DEFAULT_MODEL).trim().slice(0, 80);
  return {
    apiKey,
    baseURL: cleanBase(request.headers.get("x-lushu-llm-base")),
    model: model || DEFAULT_MODEL,
    priceInputPerMtok: 0,
    priceOutputPerMtok: 0,
    reasoningEffort: null,
    timeoutMs: 25_000,
  };
}

export function redactSecret(message: string, secret: string | null): string {
  if (!secret) return message.slice(0, 180);
  return message.split(secret).join("").slice(0, 180);
}
