import { budgetNote, buildFallbackVariants, contrastFor, sourcesFromTools } from "./fallback";
import type { ItineraryDay, ItineraryItem, PlanVariant, Source, SourceKind, ToolBundle, TripSpec } from "./types";

const KINDS = new Set<SourceKind>(["search", "weather", "stub", "model", "local"]);

function text(value: unknown, max = 500): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function textList(value: unknown, max = 8): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => text(item, 240))
    .filter((item) => item.length > 0)
    .slice(0, max);
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function allowedUrls(bundle: ToolBundle): Set<string> {
  const urls = new Set<string>();
  for (const search of bundle.searches) {
    for (const result of search.results) {
      if (result.url) urls.add(result.url);
    }
  }
  for (const report of bundle.weather) {
    if (report.sourceUrl) urls.add(report.sourceUrl);
  }
  return urls;
}

function coerceItem(raw: unknown): ItineraryItem | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const title = text(row.title, 80);
  const detail = text(row.detail, 400);
  if (!title || !detail) return null;
  const area = text(row.area, 40);
  const estCost = text(row.estCost, 40);
  return {
    time: text(row.time, 24) || "接着",
    title,
    detail,
    ...(area ? { area } : {}),
    ...(estCost ? { estCost } : {}),
  };
}

function coerceDay(raw: unknown, index: number): ItineraryDay | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const items = Array.isArray(row.items)
    ? row.items.map(coerceItem).filter((item): item is ItineraryItem => item != null)
    : [];
  if (items.length === 0) return null;
  const city = text(row.city, 20) || "当地";
  return {
    day: index + 1,
    title: text(row.title, 40) || city,
    city,
    theme: text(row.theme, 24) || "行程",
    items: items.slice(0, 4),
    meals: textList(row.meals, 4),
    stayNote: text(row.stayNote, 200) || "住宿请自己看，路书不代订。",
    rainPlanB: text(row.rainPlanB, 240) || "如果下雨，改去室内的博物馆或商场，户外顺延。",
  };
}

function coerceSources(raw: unknown, allowed: Set<string>): Source[] {
  if (!Array.isArray(raw)) return [];
  const sources: Source[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const title = text(row.title, 160);
    if (!title) continue;
    const kind = KINDS.has(row.kind as SourceKind) ? (row.kind as SourceKind) : "model";
    const url = httpUrl(row.url);
    const note = text(row.note, 240);
    sources.push({
      title,
      kind,
      ...(url && allowed.has(url) ? { url } : {}),
      ...(note ? { note } : {}),
    });
  }
  return sources.slice(0, 12);
}

function withWarnings(warnings: string[]): string[] {
  const next = [...warnings];
  if (!next.some((line) => line.includes("AI"))) {
    next.unshift("此内容由 AI 生成，仅供参考。");
  }
  if (!next.some((line) => line.includes("不代订") || line.includes("不收款"))) {
    next.push("路书不代订交通、住宿或门票，也不收款。");
  }
  return next.slice(0, 8);
}

function fitDays(days: ItineraryDay[], spec: TripSpec, bundle: ToolBundle): ItineraryDay[] {
  const sliced = days.slice(0, spec.days);
  if (sliced.length >= spec.days) {
    return sliced.map((day, index) => ({ ...day, day: index + 1 }));
  }
  const filler = buildFallbackVariants(spec, bundle, "fallback")[0]?.days ?? [];
  const merged = [...sliced];
  for (let index = sliced.length; index < spec.days; index += 1) {
    const day = filler[index];
    if (day) merged.push(day);
  }
  return merged.map((day, index) => ({ ...day, day: index + 1 }));
}

export function coercePlan(
  raw: unknown,
  spec: TripSpec,
  bundle: ToolBundle,
): { variants: PlanVariant[]; contrast: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const list = Array.isArray(body.variants) ? body.variants : [];
  const allowed = allowedUrls(bundle);
  const fallbackSources = sourcesFromTools(bundle, "llm");
  const variants: PlanVariant[] = [];

  list.slice(0, 2).forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const row = item as Record<string, unknown>;
    const days = Array.isArray(row.days)
      ? row.days
          .map((day, dayIndex) => coerceDay(day, dayIndex))
          .filter((day): day is ItineraryDay => day != null)
      : [];
    if (days.length === 0) return;
    const sources = coerceSources(row.sources, allowed);
    const budget = text(row.budgetNote, 800);
    variants.push({
      id: text(row.id, 12) || (index === 0 ? "a" : "b"),
      title: text(row.title, 40) || `方案 ${index + 1}`,
      style: text(row.style, 16) || "方案",
      summary: text(row.summary, 240),
      pace: text(row.pace, 160),
      budgetNote: budget || budgetNote(spec),
      suitability: text(row.suitability, 160),
      days: fitDays(days, spec, bundle),
      sources: sources.length > 0 ? sources : fallbackSources,
      assumptions: textList(row.assumptions, 8),
      warnings: withWarnings(textList(row.warnings, 6)),
      aiGenerated: true,
    });
  });

  if (variants.length === 0) return null;
  if (variants.length === 1) {
    const extra = buildFallbackVariants(spec, bundle, "llm")[1];
    if (extra) variants.push({ ...extra, id: "b" });
  }
  const contrast = text(body.contrast, 200) || contrastFor(variants);
  return { variants, contrast };
}
