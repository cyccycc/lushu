import { blockedModelUrlMessage, isBlockedLlmHost, modelHttpError } from "./base";
import { estimateCostUsd, type TokenUsage } from "./cost";
import { readLlmEnv, type LlmEnv } from "./env";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatResult = {
  content: string;
  usage: TokenUsage;
  estimatedUsd: number;
  model: string;
};

export class LlmError extends Error {
  readonly status: number | null;
  readonly code: "missing_key" | "http" | "timeout" | "bad_response";

  constructor(
    message: string,
    options: { status?: number | null; code: LlmError["code"] },
  ) {
    super(message);
    this.name = "LlmError";
    this.status = options.status ?? null;
    this.code = options.code;
  }
}

type ChatBody = {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  response_format?: { type: "json_object" };
  reasoning_effort?: string;
};

function chatUrl(baseURL: string): string {
  if (baseURL.endsWith("/chat/completions")) return baseURL;
  return `${baseURL}/chat/completions`;
}

function assertAllowedModelUrl(baseURL: string): void {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new LlmError(blockedModelUrlMessage, { code: "http" });
  }
  if (url.protocol !== "https:" || url.username || url.password || isBlockedLlmHost(url.hostname)) {
    throw new LlmError(blockedModelUrlMessage, { code: "http" });
  }
}

function redact(text: string, secret: string | null): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join("[redacted]");
}

function readUsage(data: unknown): TokenUsage {
  const usage =
    data && typeof data === "object" && "usage" in data
      ? (data as { usage?: Record<string, unknown> }).usage
      : undefined;
  const prompt = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
  const completion = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0);
  return {
    promptTokens: Number.isFinite(prompt) ? prompt : 0,
    completionTokens: Number.isFinite(completion) ? completion : 0,
  };
}

function readContent(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

async function postChat(
  env: LlmEnv,
  body: ChatBody,
  signal: AbortSignal | undefined,
): Promise<{ content: string; usage: TokenUsage }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    assertAllowedModelUrl(env.baseURL);
    const response = await fetch(chatUrl(env.baseURL), {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new LlmError(modelHttpError(response.status), {
        status: response.status,
        code: "http",
      });
    }
    const raw = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new LlmError("模型接口没有返回 JSON。", { code: "bad_response" });
    }
    const content = readContent(data);
    if (!content.trim()) {
      throw new LlmError("模型没有返回文本。", { code: "bad_response" });
    }
    return { content, usage: readUsage(data) };
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (controller.signal.aborted && !signal?.aborted) {
      throw new LlmError(`模型请求超过 ${env.timeoutMs}ms。`, { code: "timeout" });
    }
    const message = error instanceof Error ? error.message : "网络错误";
    throw new LlmError(redact(message, env.apiKey), { code: "http" });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function chatComplete(options: {
  messages: ChatMessage[];
  json?: boolean;
  temperature?: number;
  signal?: AbortSignal;
  env?: LlmEnv;
}): Promise<ChatResult> {
  const env = options.env ?? readLlmEnv();
  if (!env.apiKey) {
    throw new LlmError("未配置 LLM_API_KEY。", { code: "missing_key" });
  }

  const body: ChatBody = {
    model: env.model,
    messages: options.messages,
    temperature: options.temperature ?? 0.4,
  };
  if (options.json) body.response_format = { type: "json_object" };
  if (env.reasoningEffort) body.reasoning_effort = env.reasoningEffort;

  let result: { content: string; usage: TokenUsage };
  try {
    result = await postChat(env, body, options.signal);
  } catch (error) {
    const canRetry =
      error instanceof LlmError &&
      error.status === 400 &&
      (body.response_format != null || body.reasoning_effort != null);
    if (!canRetry) throw error;
    delete body.response_format;
    delete body.reasoning_effort;
    result = await postChat(env, body, options.signal);
  }

  return {
    content: result.content,
    usage: result.usage,
    estimatedUsd: estimateCostUsd(result.usage, env),
    model: env.model,
  };
}
