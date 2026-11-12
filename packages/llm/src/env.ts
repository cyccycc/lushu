export type LlmEnv = {
  apiKey: string | null;
  baseURL: string;
  model: string;
  priceInputPerMtok: number;
  priceOutputPerMtok: number;
  reasoningEffort: string | null;
  timeoutMs: number;
};

function num(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function isDeepSeek(model: string, baseURL: string): boolean {
  return /deepseek/i.test(model) || /deepseek/i.test(baseURL);
}

/** Unset effort: DeepSeek omits the field. Other providers still send low. An explicit value is kept. */
function reasoningEffortFrom(env: NodeJS.ProcessEnv, model: string, baseURL: string): string | null {
  const raw = env.LLM_REASONING_EFFORT;
  const effort = (raw == null && !isDeepSeek(model, baseURL) ? "low" : (raw ?? "")).trim();
  return effort.length > 0 ? effort : null;
}

export function readLlmEnv(env: NodeJS.ProcessEnv = process.env): LlmEnv {
  const apiKey = (env.LLM_API_KEY || env.XAI_API_KEY || "").trim() || null;
  const baseURL = (env.LLM_BASE_URL || "https://api.x.ai/v1").trim().replace(/\/$/, "");
  const model = (env.LLM_MODEL || "grok-4.7").trim();
  return {
    apiKey,
    baseURL,
    model,
    priceInputPerMtok: num(env.LLM_PRICE_INPUT_PER_MTOK, 2),
    priceOutputPerMtok: num(env.LLM_PRICE_OUTPUT_PER_MTOK, 6),
    reasoningEffort: reasoningEffortFrom(env, model, baseURL),
    timeoutMs: Math.max(5_000, num(env.LLM_TIMEOUT_MS, 120_000)),
  };
}

export function hasLlmKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return readLlmEnv(env).apiKey != null;
}
