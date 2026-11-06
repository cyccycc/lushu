import { blockedModelUrlMessage, resolveLlmBase, type LlmEnv } from "@lushu/llm";

const DEFAULT_BASE = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";

export type LlmEnvFromRequest =
  | { ok: true; env: LlmEnv }
  | { ok: false; error: string | null };

/**
 * The model key is read from this request only.
 * Do not write it to disk, do not log the header, and do not fall back to LLM_API_KEY.
 * A blocked custom base URL is an error. It is not silently replaced by the default host.
 */
export function llmEnvFromRequest(request: Request): LlmEnvFromRequest {
  const apiKey = request.headers.get("x-lushu-llm-key")?.trim() ?? "";
  if (!apiKey || apiKey.length > 400) return { ok: false, error: null };
  const model = (request.headers.get("x-lushu-llm-model") || DEFAULT_MODEL).trim().slice(0, 80);
  const base = resolveLlmBase(request.headers.get("x-lushu-llm-base"), DEFAULT_BASE);
  if (!base.ok) return { ok: false, error: blockedModelUrlMessage };
  return {
    ok: true,
    env: {
      apiKey,
      baseURL: base.baseURL,
      model: model || DEFAULT_MODEL,
      priceInputPerMtok: 0,
      priceOutputPerMtok: 0,
      reasoningEffort: null,
      timeoutMs: 25_000,
    },
  };
}

export function redactSecret(message: string, secret: string | null): string {
  if (!secret) return message.slice(0, 180);
  return message.split(secret).join("").slice(0, 180);
}
