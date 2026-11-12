import { shanghaiDate } from "./time";
import type { ItemSource, RoadbookItem, SourceKind, VerifyItem, WeatherSnap } from "./types";

export const WEATHER_STALE_MS = 24 * 60 * 60 * 1000;
export const SEARCH_STALE_MS = 30 * 24 * 60 * 60 * 1000;

const STATED_NOTE = "来自你的原话";
const EDITED_NOTE = "你改的时间";

/** User-stated appointments. The clock may still be a guess; the fact is not. */
const USER_ERRAND = /体检|开会|会议/;

export type FactMark = {
  kind: SourceKind;
  /** Remark or search title to show next to the kind. */
  note?: string;
  /** Calendar date of a search fetch, in Asia/Shanghai. */
  fetchedOn?: string;
  url?: string;
  stale: boolean;
  /** A 检索 row is missing its link or its fetch time. */
  unavailable: boolean;
  /** Model suggestion the reader still has to check. User-stated errands are false. */
  needsVerify: boolean;
};

export type WeatherMark = {
  unavailable: boolean;
  stale: boolean;
  /** Date and condition, without temperatures. */
  heading: string;
  /** Condition and temperatures, or 暂不可用. Never fills in a missing number. */
  summary: string;
};

function ageMs(fetchedAt: string | undefined, now: Date): number | null {
  if (!fetchedAt) return null;
  const at = Date.parse(fetchedAt);
  if (!Number.isFinite(at)) return null;
  return now.getTime() - at;
}

export function isSearchStale(source: ItemSource, now = new Date()): boolean {
  if (source.kind !== "检索") return false;
  const age = ageMs(source.fetchedAt, now);
  return age != null && age > SEARCH_STALE_MS;
}

export function isWeatherStale(snap: WeatherSnap, now = new Date()): boolean {
  if (!snap.available) return false;
  const age = ageMs(snap.fetchedAt, now);
  return age != null && age > WEATHER_STALE_MS;
}

function confirmedRemark(note: string | undefined): boolean {
  if (!note || note.includes("原话没")) return false;
  return note.includes(STATED_NOTE) || note.includes(EDITED_NOTE);
}

/** Old books stored user-confirmed facts as 推断. Reading maps those notes onto 实测. */
export function relabelConfirmedSource(source: ItemSource): ItemSource {
  if (source.kind !== "推断" || !confirmedRemark(source.note)) return source;
  return { ...source, kind: "实测" };
}

function userStatedErrand(item: Pick<RoadbookItem, "title" | "note" | "source">): boolean {
  if (!USER_ERRAND.test(item.title)) return false;
  const blob = `${item.note ?? ""} ${item.source.note ?? ""}`;
  if (blob.includes("办事行程补位")) return false;
  return true;
}

export function factMark(item: Pick<RoadbookItem, "title" | "note" | "source">, now = new Date()): FactMark {
  const source = relabelConfirmedSource(item.source);
  const confirmed = confirmedRemark(source.note);
  if (source.kind === "检索") {
    const parsed = source.fetchedAt ? Date.parse(source.fetchedAt) : Number.NaN;
    const hasDate = Number.isFinite(parsed);
    const hasUrl = Boolean(source.url && /^https?:\/\//.test(source.url));
    return {
      kind: "检索",
      note: source.note,
      fetchedOn: hasDate ? shanghaiDate(new Date(parsed)) : undefined,
      url: hasUrl ? source.url : undefined,
      stale: hasDate && isSearchStale(source, now),
      unavailable: !hasUrl || !hasDate,
      needsVerify: false,
    };
  }
  return {
    kind: source.kind,
    note: source.kind === "推断" ? undefined : source.note,
    stale: false,
    unavailable: false,
    needsVerify: source.kind === "推断" && !confirmed && !userStatedErrand(item),
  };
}

export function weatherMark(snap: WeatherSnap | undefined, now = new Date()): WeatherMark {
  if (!snap || !snap.available) return { unavailable: true, stale: false, heading: "暂不可用", summary: "暂不可用" };
  const heading = `${snap.date ?? ""} ${snap.condition}`.replace(/\s+/g, " ").trim();
  const temps =
    snap.tempMinC == null || snap.tempMaxC == null ? "暂不可用" : `${snap.tempMinC}–${snap.tempMaxC}°C`;
  const summary = `${heading} ${temps}`.trim();
  return { unavailable: false, stale: isWeatherStale(snap, now), heading, summary };
}

export function checklistRowRetired(row: VerifyItem, items: { id: string }[]): boolean {
  return Boolean(row.itemId) && !items.some((item) => item.id === row.itemId);
}

/** Owner keeps 「需要你核实」. Companions on the share page see 「未核实」. */
export function verifyCue(needsVerify: boolean, viewer: "owner" | "share"): string {
  if (!needsVerify) return "";
  return viewer === "share" ? "未核实" : "需要你核实";
}
