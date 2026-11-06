import { fetchJson, safeHttpUrl } from "./http";
import { normalizeWeatherQuery } from "./place";
import type { ToolMode, WeatherDay, WeatherReport } from "./types";

const WMO: Record<number, string> = {
  0: "晴",
  1: "大部晴朗",
  2: "多云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "毛毛雨",
  55: "较强毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  80: "阵雨",
  81: "较强阵雨",
  82: "强阵雨",
  95: "雷暴",
  96: "雷暴伴冰雹",
  99: "强雷暴",
};

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function summaryFor(code: number | null): string {
  if (code == null || Number.isNaN(code)) return "天气未知";
  return WMO[code] ?? (code >= 50 ? "可能有降水" : "天气多变");
}

function stubReport(query: string, note: string): WeatherReport {
  return {
    query,
    resolvedName: null,
    timezone: null,
    days: [],
    stub: true,
    sourceUrl: null,
    note,
  };
}

type GeoHit = {
  name: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  country?: string;
  admin1?: string;
};

async function geocode(query: string): Promise<GeoHit | null> {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "zh");
  url.searchParams.set("format", "json");
  const data = await fetchJson(url.toString(), { timeoutMs: 8000 });
  const results = (data as { results?: GeoHit[] }).results;
  const hit = results?.[0];
  if (!hit || typeof hit.latitude !== "number" || typeof hit.longitude !== "number") return null;
  return hit;
}

export async function getWeather(
  location: string,
  days: number,
  options: { mode?: ToolMode; alternateName?: string } = {},
): Promise<WeatherReport> {
  const normalized = normalizeWeatherQuery(location, options.alternateName);
  const query = normalized.query.trim().slice(0, 40);
  if (!query) {
    return stubReport(location.slice(0, 80), "没有解析出地名。不会把整句当地名去查天气。");
  }
  if (options.mode === "stub") {
    return stubReport(query, "评测或离线模式不请求天气接口。出发前请再查预报。");
  }

  const forecastDays = Math.min(16, Math.max(1, Math.round(days) || 3));
  try {
    const alternate = normalized.alternateName?.trim();
    const hit = (await geocode(query)) ?? (alternate && alternate !== query ? await geocode(alternate) : null);
    if (!hit) {
      return stubReport(query, `没有解析到「${query}」的坐标。出发前请再查当地预报。`);
    }
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(hit.latitude));
    url.searchParams.set("longitude", String(hit.longitude));
    url.searchParams.set(
      "daily",
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    );
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("forecast_days", String(forecastDays));
    const sourceUrl = safeHttpUrl(url.toString());
    const data = await fetchJson(url.toString(), { timeoutMs: 8000 });
    const daily = (data as { daily?: Record<string, unknown[]> }).daily;
    const dates = daily?.time ?? [];
    const codes = daily?.weather_code ?? daily?.weathercode ?? [];
    const tmax = daily?.temperature_2m_max ?? [];
    const tmin = daily?.temperature_2m_min ?? [];
    const precip = daily?.precipitation_probability_max ?? [];
    const out: WeatherDay[] = [];
    for (let i = 0; i < dates.length; i += 1) {
      const code = asNumber(codes[i]);
      const high = asNumber(tmax[i]);
      const low = asNumber(tmin[i]);
      const chance = asNumber(precip[i]);
      out.push({
        date: String(dates[i]),
        summary: summaryFor(code),
        tempMaxC: high == null ? null : Math.round(high),
        tempMinC: low == null ? null : Math.round(low),
        precipProbability: chance == null ? null : Math.round(chance),
      });
    }
    const label = [hit.name, hit.admin1].filter(Boolean).join(" · ");
    const rewritten = location.trim() !== query;
    return {
      query,
      resolvedName: label || hit.name,
      timezone: typeof (data as { timezone?: unknown }).timezone === "string"
        ? (data as { timezone: string }).timezone
        : hit.timezone ?? null,
      days: out,
      stub: false,
      sourceUrl,
      note:
        out.length === 0
          ? "预报接口没有返回逐日数据。"
          : rewritten
            ? `已按「${query}」查询，没有把整句当地名。`
            : undefined,
    };
  } catch {
    return stubReport(query, "天气接口没有连上。出发前请再查一次预报。");
  }
}
