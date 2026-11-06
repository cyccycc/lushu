import { clip, fetchJson, safeHttpUrl } from "./http";
import type { SearchResponse, SearchResult, ToolMode } from "./types";

type Provider = "tavily" | "brave" | "stub";

function searchEnv(env: NodeJS.ProcessEnv) {
  const provider = (env.SEARCH_PROVIDER || "auto").trim().toLowerCase();
  const searchKey = (env.SEARCH_API_KEY || "").trim();
  const tavily = (env.TAVILY_API_KEY || "").trim() || (provider !== "brave" ? searchKey : "");
  const brave =
    (env.BRAVE_SEARCH_API_KEY || env.BRAVE_API_KEY || "").trim() ||
    (provider === "brave" ? searchKey : "");
  return { provider, tavily, brave };
}

function chooseProvider(env: NodeJS.ProcessEnv, mode: ToolMode): Provider {
  if (mode === "stub") return "stub";
  const cfg = searchEnv(env);
  if (cfg.provider === "stub") return "stub";
  if (cfg.provider === "tavily") return cfg.tavily ? "tavily" : "stub";
  if (cfg.provider === "brave") return cfg.brave ? "brave" : "stub";
  if (cfg.tavily) return "tavily";
  if (cfg.brave) return "brave";
  return "stub";
}

function stubResponse(query: string, note: string): SearchResponse {
  return {
    query,
    provider: "stub",
    stub: true,
    note,
    results: [
      {
        title: "未配置网页检索",
        url: null,
        snippet:
          "没有 SEARCH_API_KEY（或 Tavily / Brave 密钥）。不要把这条当成实时检索。开放时间、票价和班次都请出发前核实。",
      },
    ],
  };
}

function asResults(items: SearchResult[]): SearchResult[] {
  return items
    .filter((item) => item.title.trim().length > 0)
    .slice(0, 5)
    .map((item) => ({
      title: clip(item.title, 160),
      url: safeHttpUrl(item.url),
      snippet: clip(item.snippet || "", 400),
    }));
}

async function searchTavily(query: string, apiKey: string): Promise<SearchResponse> {
  const data = await fetchJson("https://api.tavily.com/search", {
    method: "POST",
    timeoutMs: 10000,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "basic",
      max_results: 5,
      include_answer: false,
    }),
  });
  const rows = Array.isArray((data as { results?: unknown }).results)
    ? (data as { results: Array<Record<string, unknown>> }).results
    : [];
  const results = asResults(
    rows.map((row) => ({
      title: String(row.title ?? ""),
      url: typeof row.url === "string" ? row.url : null,
      snippet: String(row.content ?? row.snippet ?? ""),
    })),
  );
  return {
    query,
    provider: "tavily",
    stub: false,
    results,
    note: results.length === 0 ? "检索没有返回结果。" : undefined,
  };
}

async function searchBrave(query: string, apiKey: string): Promise<SearchResponse> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "5");
  url.searchParams.set("search_lang", "zh-hans");
  const data = await fetchJson(url.toString(), {
    timeoutMs: 10000,
    headers: { "X-Subscription-Token": apiKey },
  });
  const web = (data as { web?: { results?: Array<Record<string, unknown>> } }).web;
  const rows = web?.results ?? [];
  const results = asResults(
    rows.map((row) => ({
      title: String(row.title ?? ""),
      url: typeof row.url === "string" ? row.url : null,
      snippet: String(row.description ?? ""),
    })),
  );
  return {
    query,
    provider: "brave",
    stub: false,
    results,
    note: results.length === 0 ? "检索没有返回结果。" : undefined,
  };
}

export async function webSearch(
  query: string,
  options: { mode?: ToolMode; env?: NodeJS.ProcessEnv } = {},
): Promise<SearchResponse> {
  const q = query.trim().slice(0, 200);
  if (!q) {
    return stubResponse(query, "查询为空。");
  }
  const env = options.env ?? process.env;
  const provider = chooseProvider(env, options.mode ?? "auto");
  if (provider === "stub") {
    return stubResponse(q, "搜索密钥缺失或被关掉了，这一步是占位结果。");
  }
  const cfg = searchEnv(env);
  try {
    if (provider === "tavily") return await searchTavily(q, cfg.tavily);
    return await searchBrave(q, cfg.brave);
  } catch {
    return stubResponse(q, "网页检索失败，已改用占位说明。开放时间与价格请出发前核实。");
  }
}
