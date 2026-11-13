import { shanghaiDate } from "./time";
import type { ItemSource, RoadbookItem, SourceKind, VerifyItem, WeatherSnap } from "./types";

export const WEATHER_STALE_MS = 24 * 60 * 60 * 1000;
export const SEARCH_STALE_MS = 30 * 24 * 60 * 60 * 1000;

const STATED_NOTE = "来自你的原话";
const EDITED_TIME_NOTE = "你改的时间";
const EDITED_DURATION_NOTE = "你改的时长";
const FILLER_ERRAND_NOTE = "办事行程补位";
const HTTP_URL = /^https?:\/\//;

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

function fetchedAtStale(fetchedAt: string | undefined, now: Date): boolean {
  const age = ageMs(fetchedAt, now);
  return age != null && age > SEARCH_STALE_MS;
}

export function isSearchStale(source: ItemSource, now = new Date()): boolean {
  if (source.kind !== "检索") return false;
  return fetchedAtStale(source.fetchedAt, now);
}

function usableHttpUrl(url: string | undefined): string | undefined {
  return url && HTTP_URL.test(url) ? url : undefined;
}

/**
 * The user moved the clock or the duration and left the title and place alone.
 * Kind becomes 实测. The note defaults to 你改的时间; pass 你改的时长 for a duration edit.
 * A usable http(s) link stays, with its fetch time.
 */
export function sourceAfterUserClock(source: ItemSource, note = EDITED_TIME_NOTE): ItemSource {
  const next: ItemSource = { kind: "实测", note };
  const url = usableHttpUrl(source.url);
  if (!url) return next;
  next.url = url;
  if (source.fetchedAt) next.fetchedAt = source.fetchedAt;
  return next;
}

export function isWeatherStale(snap: WeatherSnap, now = new Date()): boolean {
  if (!snap.available) return false;
  const age = ageMs(snap.fetchedAt, now);
  return age != null && age > WEATHER_STALE_MS;
}

function confirmedRemark(note: string | undefined): boolean {
  if (!note || note.includes("原话没")) return false;
  return note.includes(STATED_NOTE) || note.includes(EDITED_TIME_NOTE) || note.includes(EDITED_DURATION_NOTE);
}

/** Old books stored user-confirmed facts as 推断. Reading maps those notes onto 实测. */
export function relabelConfirmedSource(source: ItemSource): ItemSource {
  if (source.kind !== "推断" || !confirmedRemark(source.note)) return source;
  return { ...source, kind: "实测" };
}

/**
 * 办事 the user actually said. The clock may still be 时间推断.
 * Filler slots are marked 办事行程补位 and stay unverified. Saved books need no new field.
 */
export function userStatedErrand(item: Pick<RoadbookItem, "type" | "note" | "source">): boolean {
  if (item.type !== "办事") return false;
  const blob = `${item.note ?? ""} ${item.source.note ?? ""}`;
  return !blob.includes(FILLER_ERRAND_NOTE);
}

function fetchStamp(fetchedAt: string | undefined, now: Date): { fetchedOn?: string; stale: boolean } {
  const parsed = fetchedAt ? Date.parse(fetchedAt) : Number.NaN;
  if (!Number.isFinite(parsed)) return { stale: false };
  return {
    fetchedOn: shanghaiDate(new Date(parsed)),
    stale: fetchedAtStale(fetchedAt, now),
  };
}

export function factMark(item: Pick<RoadbookItem, "type" | "title" | "note" | "source">, now = new Date()): FactMark {
  const source = relabelConfirmedSource(item.source);
  const confirmed = confirmedRemark(source.note);
  const url = usableHttpUrl(source.url);
  if (source.kind === "检索") {
    const fetched = fetchStamp(source.fetchedAt, now);
    return {
      kind: "检索",
      note: source.note,
      fetchedOn: fetched.fetchedOn,
      url,
      stale: fetched.stale,
      unavailable: !url || !fetched.fetchedOn,
      needsVerify: false,
    };
  }
  // A clock edit is 实测, but the place link is still the one to open and to age.
  if (source.kind === "实测" && url) {
    const fetched = fetchStamp(source.fetchedAt, now);
    return {
      kind: "实测",
      note: source.note,
      fetchedOn: fetched.fetchedOn,
      url,
      stale: fetched.stale,
      unavailable: false,
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
