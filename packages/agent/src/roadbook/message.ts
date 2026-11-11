import { citiesInText } from "@lushu/tools/place";
import {
  buildDraft,
  fitInferredReturn,
  itemsForDay,
  repeatRequested,
  returnAssumptionValue,
  returnEarliestMinute,
  returnEstimateNote,
  statedReturnClock,
  wantsInferredReturn,
} from "./draft";
import { parseZhNumber } from "../parse";
import { projectPatch } from "./patch";
import { formatTime, inferStartDate, inferWeekdayDate, isUnsetWhen, noteForPlacedClock, parseTime } from "./time";
import type { PatchOp, Plan, Roadbook, RoadbookItem } from "./types";

const REGEN_NOTICE = "未锁定的改动已重排。";
const HAND_EDITED_DETAIL = "已手动修改";
const SKIPPED_RETURN_VALUE = "这次不补";
const SKIPPED_RETURN_DETAIL = "超过短途，不再补返程";
const USER_CLOCK_NOTE = "这个钟点是你改的。";
const USER_CLOCK_SOURCE = "你改的时间";

function canRefreshReturnChip(item: Roadbook["assumptions"][number]): boolean {
  if (item.detail === HAND_EDITED_DETAIL) return false;
  if (item.inferred) return true;
  return item.value === SKIPPED_RETURN_VALUE && item.detail === SKIPPED_RETURN_DETAIL;
}

function findItem(book: Roadbook, name: string): RoadbookItem | undefined {
  const query = name.trim().replace(/[。！？\s]+$/g, "");
  if (!query) return undefined;
  return book.items.find(
    (item) => item.title.includes(query) || query.includes(item.title) || item.place.includes(query),
  );
}

function clock(rawHour: string, rawMinute?: string): string | null {
  const hour = Number(rawHour);
  const minute = rawMinute == null || rawMinute === "" ? 0 : Number(rawMinute);
  if (!Number.isInteger(hour) || hour > 23 || !Number.isInteger(minute) || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function assumptionOf(book: Roadbook, key: Roadbook["assumptions"][number]["key"]) {
  return book.assumptions.find((item) => item.key === key);
}

function partyValue(count: number): string {
  if (count === 1) return "一个人";
  if (count === 2) return "两个人";
  return `${count} 个人`;
}

function overlapsLocked(startTime: string, durationMinutes: number, locked: RoadbookItem[]): boolean {
  const start = parseTime(startTime);
  if (start == null) return false;
  const end = start + durationMinutes;
  return locked.some((item) => {
    const other = parseTime(item.startTime);
    if (other == null) return false;
    return start < other + item.durationMinutes && end > other;
  });
}

function userAddedIds(book: Roadbook): Set<string> {
  const ids = new Set<string>();
  for (const patch of book.patchHistory) {
    if (patch.kind !== "user" && patch.kind !== "model") continue;
    for (const op of patch.ops) {
      if (op.op === "add") ids.add(op.item.id);
    }
  }
  return ids;
}

function manuallyTouchedIds(book: Roadbook): Set<string> {
  const ids = new Set<string>();
  for (const patch of book.patchHistory) {
    if (patch.kind === "draft" || patch.kind === "assumption") continue;
    for (const op of patch.ops) {
      if (op.op === "add") ids.add(op.item.id);
      else if (op.op === "update") ids.add(op.id);
    }
  }
  return ids;
}

function overlapsItem(startTime: string, durationMinutes: number, item: RoadbookItem): boolean {
  return overlapsLocked(startTime, durationMinutes, [item]);
}

function tripOrigin(book: Roadbook): string | null {
  const value = book.assumptions.find((item) => item.key === "origin")?.value?.trim() ?? "";
  if (!value || value === "当地集合") return null;
  return value;
}

function intercityLegs(book: Roadbook): RoadbookItem[] {
  return book.items
    .filter((item) => item.type === "交通" && (item.title.startsWith("从") || item.title.startsWith("返回") || item.title.startsWith("到达")))
    .sort((a, b) => a.dayIndex - b.dayIndex || (parseTime(a.startTime) ?? 0) - (parseTime(b.startTime) ?? 0));
}

function returnLeg(book: Roadbook): RoadbookItem | undefined {
  const legs = intercityLegs(book);
  const station = book.items.find((item) => item.title === "去车站");
  if (station) {
    const stationStart = parseTime(station.startTime) ?? 0;
    const paired = legs.find((item) => item.dayIndex === station.dayIndex && (parseTime(item.startTime) ?? 0) >= stationStart);
    if (paired) return paired;
  }
  const named = [...legs].reverse().find((item) => item.title.startsWith("返回"));
  if (named) return named;
  if (legs.length >= 2) return legs[legs.length - 1];
  return legs.find((item) => /返回|返程/.test(`${item.title}${item.note ?? ""}`));
}

function stationItem(book: Roadbook, day?: number): RoadbookItem | undefined {
  return book.items.find((item) => item.title === "去车站" && (day == null || item.dayIndex === day));
}

function bookKind(book: Roadbook): "旅游" | "办事" | "混合" {
  if (book.extract?.kind === "办事" || book.extract?.kind === "混合") return book.extract.kind;
  if (book.items.some((item) => item.type === "办事") || /体检|开会|会议|出差|面试|看病/.test(book.brief)) {
    return book.items.some((item) => item.type === "景点") ? "混合" : "办事";
  }
  return "旅游";
}

function fillerItem(
  id: string,
  day: number,
  city: string,
  startTime: string,
  durationMinutes: number,
  title: string,
  type: RoadbookItem["type"],
): RoadbookItem {
  return {
    id,
    dayIndex: day,
    startTime,
    durationMinutes,
    title,
    place: city === "未写明的目的地" ? "待定" : city,
    lat: null,
    lng: null,
    type,
    status: "待做",
    source: { kind: "推断", note: "办事行程补位" },
    travelEstimateMinutes: 10,
    estimateSource: "推断",
    locked: false,
    priority: "想去",
    indoor: true,
    highlight: false,
    note: "办事行程，不套用景点。",
  };
}

function briefHasReturnWords(brief: string): boolean {
  if (/不回来|不返回|不返程/.test(brief)) return false;
  return /返程|回来|返回|回程|当天回|当日往返|当日回/.test(brief);
}

function returnIsExplicit(book: Roadbook, item: RoadbookItem | undefined): boolean {
  if (!item) return false;
  if (item.locked) return true;
  if (item.note?.includes("来自你的原话")) return true;
  return statedReturnClock(book.brief) != null;
}

/** Unlocked inferred returns exist only while the trip is still a short hop and the brief never mentioned coming back. */
function dropInferredReturn(book: Roadbook, back: RoadbookItem | undefined, days: number): boolean {
  if (!back || returnIsExplicit(book, back)) return false;
  if (briefHasReturnWords(book.brief)) return false;
  return days > 3;
}

function rangesOverlap(start: number, duration: number, otherStart: number, otherDuration: number): boolean {
  return start < otherStart + otherDuration && start + duration > otherStart;
}

function hitsCutoff(item: RoadbookItem, cutoff: number): boolean {
  const start = parseTime(item.startTime);
  if (start == null) return false;
  return start >= cutoff || start + item.durationMinutes > cutoff;
}

function lockedBlocksReturn(item: RoadbookItem, cutoff: number, returnStart: number, ride: number): boolean {
  const start = parseTime(item.startTime);
  if (start == null) return false;
  if (start >= cutoff || start >= returnStart) return true;
  return rangesOverlap(start, item.durationMinutes, cutoff, Math.max(60, returnStart - cutoff)) || rangesOverlap(start, item.durationMinutes, returnStart, ride);
}

function chooseInferredReturnStart(current: number, ride: number, locked: RoadbookItem[]): number | null {
  const conflicts = (start: number) => {
    const cutoff = start >= 60 ? start - 60 : start;
    return locked.some((item) => lockedBlocksReturn(item, cutoff, start, ride));
  };
  if (!conflicts(current)) return current;
  const earliest = returnEarliestMinute(locked);
  const fitted = fitInferredReturn(ride, earliest).start;
  if (!conflicts(fitted)) return fitted;
  const fallback = 18 * 60;
  if (fallback !== fitted && !conflicts(fallback)) return fallback;
  return null;
}

function stationFor(book: Roadbook, back: RoadbookItem | undefined): RoadbookItem | undefined {
  if (!back) return stationItem(book);
  return stationItem(book, back.dayIndex) ?? stationItem(book);
}

function rebuildErrandDays(
  book: Roadbook,
  days: number,
  random?: () => string,
): { ops: PatchOp[]; droppedManual: boolean; error?: string } {
  const next = random ?? (() => Math.random().toString(36).slice(2, 8));
  const manual = manuallyTouchedIds(book);
  const added = userAddedIds(book);
  const kind = bookKind(book);
  const back = returnLeg(book);
  const outbound = intercityLegs(book).find((item) => item.id !== back?.id);
  const keep = new Map<string, number>();
  const remember = (item: RoadbookItem, dayIndex: number) => {
    keep.set(item.id, Math.min(days, Math.max(1, dayIndex)));
  };
  for (const item of book.items) {
    if (outbound?.id === item.id || back?.id === item.id || item.title === "去车站") continue;
    if (item.locked && item.dayIndex <= days) remember(item, item.dayIndex);
    else if (item.type === "办事") remember(item, item.dayIndex <= days ? item.dayIndex : days);
    else if ((item.type === "餐" || item.type === "休息") && item.dayIndex <= days) remember(item, item.dayIndex);
    else if (kind === "混合" && item.type === "景点" && item.dayIndex <= days) remember(item, item.dayIndex);
    else if (added.has(item.id) && item.type !== "景点" && item.dayIndex <= days) remember(item, item.dayIndex);
  }
  if (outbound) remember(outbound, Math.min(outbound.dayIndex, days));
  const dropReturn = dropInferredReturn(book, back, days);
  const station = stationFor(book, back);
  if (back && !dropReturn) remember(back, days);
  if (station && !dropReturn) remember(station, back ? days : Math.min(station.dayIndex, days));
  const timeEdits = new Map<string, string>();
  const durationEdits = new Map<string, number>();
  if (back && !dropReturn && !returnIsExplicit(book, back)) {
    const ride = back.travelEstimateMinutes ?? back.durationMinutes;
    const onDay = book.items.filter((item) => keep.get(item.id) === days && item.locked && item.type !== "交通");
    const current = parseTime(back.startTime) ?? 18 * 60;
    const start = chooseInferredReturnStart(current, ride, onDay);
    if (start == null) {
      const cutoff = current >= 60 ? current - 60 : current;
      const blocker = onDay.find((item) => lockedBlocksReturn(item, cutoff, current, ride));
      const name = blocker?.title ?? "锁定安排";
      return { ops: [], droppedManual: false, error: `返程和已锁定的「${name}」撞在一起，没能排开。` };
    }
    if (start !== current) {
      timeEdits.set(back.id, formatTime(start));
      if (station && keep.has(station.id) && start >= 60) timeEdits.set(station.id, formatTime(start - 60));
    }
    const cutoff = start >= 60 ? start - 60 : start;
    for (const item of book.items) {
      if (keep.get(item.id) !== days || item.locked) continue;
      if (item.id === back.id || item.id === station?.id) continue;
      if (!hitsCutoff(item, cutoff)) continue;
      const itemStart = parseTime(item.startTime) ?? 0;
      const room = cutoff - itemStart;
      if (itemStart < cutoff && room >= 30) durationEdits.set(item.id, room);
      else keep.delete(item.id);
    }
  }

  const ops: PatchOp[] = [];
  for (const item of book.items) {
    if (!keep.has(item.id)) ops.push({ op: "remove", id: item.id });
  }
  for (const [id, dayIndex] of keep) {
    const prev = book.items.find((item) => item.id === id);
    if (!prev) continue;
    const startTime = timeEdits.get(id);
    const fields: { dayIndex?: number; startTime?: string; durationMinutes?: number } = {};
    if (prev.dayIndex !== dayIndex) fields.dayIndex = dayIndex;
    if (startTime && startTime !== prev.startTime) fields.startTime = startTime;
    const shorter = durationEdits.get(id);
    if (shorter != null && shorter !== prev.durationMinutes) fields.durationMinutes = shorter;
    if (fields.dayIndex == null && fields.startTime == null && fields.durationMinutes == null) continue;
    if (prev.locked) ops.push({ op: "update", id, fields: { locked: false } });
    ops.push({ op: "update", id, fields });
    if (prev.locked) ops.push({ op: "update", id, fields: { locked: true } });
  }
  for (let day = 1; day <= days; day += 1) {
    const present = book.items.some((item) => keep.get(item.id) === day);
    if (present) continue;
    ops.push({ op: "add", item: fillerItem(`i_${next()}`, day, book.city, "12:00", 50, "附近吃饭", "餐") });
    ops.push({ op: "add", item: fillerItem(`i_${next()}`, day, book.city, "18:00", 80, "回住处休息", "休息") });
  }
  return {
    ops,
    droppedManual: book.items.some((item) => !keep.has(item.id) && manual.has(item.id)),
  };
}

function retargetGeneratedReturn(entries: RoadbookItem[], locked: RoadbookItem[], day: number): string | null {
  const rideItem = entries.find((item) => item.dayIndex === day && item.title.startsWith("返回"));
  if (!rideItem) return null;
  const ride = rideItem.travelEstimateMinutes ?? rideItem.durationMinutes;
  const blocks = locked.filter((item) => item.dayIndex === day && item.type !== "交通");
  const current = parseTime(rideItem.startTime) ?? 18 * 60;
  const start = chooseInferredReturnStart(current, ride, blocks);
  if (start == null) {
    const name = blocks.find((item) => lockedBlocksReturn(item, current >= 60 ? current - 60 : current, current, ride))?.title ?? "锁定安排";
    return `返程和已锁定的「${name}」撞在一起，没能排开。`;
  }
  if (start !== current) {
    rideItem.startTime = formatTime(start);
    const note = noteForPlacedClock(rideItem.note, rideItem.startTime, ride);
    if (note !== rideItem.note) rideItem.note = note;
  }
  const station = entries.find((item) => item.dayIndex === day && item.title === "去车站");
  if (station && start >= 60) station.startTime = formatTime(start - 60);
  const cutoff = start >= 60 ? start - 60 : start;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.dayIndex !== day || entry.id === rideItem.id || entry.id === station?.id) continue;
    if (!hitsCutoff(entry, cutoff)) continue;
    entries.splice(index, 1);
  }
  return null;
}

function rebuildForDayCount(
  book: Roadbook,
  days: number,
  random?: () => string,
): { ops: PatchOp[]; droppedManual: boolean; error?: string } {
  const manual = manuallyTouchedIds(book);
  const added = userAddedIds(book);
  const lockedKeep = book.items.filter((item) => item.locked && item.dayIndex <= days);
  const addedCandidates = book.items.filter(
    (item) => added.has(item.id) && !item.locked && item.dayIndex >= 1 && item.dayIndex <= days,
  );
  if (bookKind(book) !== "旅游") return rebuildErrandDays(book, days, random);
  const origin = tripOrigin(book);
  const existingReturn = returnLeg(book);
  const dropReturn = dropInferredReturn(book, existingReturn, days);
  const explicitReturn = returnIsExplicit(book, existingReturn);
  const landmark = citiesInText(book.brief).find((hit) => hit.city === book.city)?.landmark ?? null;
  const next = random ?? (() => Math.random().toString(36).slice(2, 8));
  const keptSights = book.items.filter((item) => item.type === "景点" && item.dayIndex >= 1 && item.dayIndex <= days);
  const keptSightIds = new Set(keptSights.map((item) => item.id));
  const used = new Map<string, number>();
  for (const item of keptSights) {
    used.set(item.title, (used.get(item.title) ?? 0) + 1);
  }
  const generated: RoadbookItem[] = [];
  for (let day = 1; day <= days; day += 1) {
    const dayLocked = lockedKeep.filter((item) => item.dayIndex === day);
    const daySights = keptSights.filter((item) => item.dayIndex === day);
    for (const entry of itemsForDay(book.city, day, days, next, {
      origin,
      withReturn:
        !dropReturn &&
        !explicitReturn &&
        wantsInferredReturn({ brief: book.brief, origin, city: book.city, days }),
      mustVisit: landmark,
      used,
      allowRepeat: repeatRequested(book.brief),
    })) {
      if (dayLocked.some((item) => item.title === entry.title)) continue;
      if (daySights.length > 0 && (entry.type === "景点" || entry.title === "自由活动")) continue;
      if (entry.type !== "交通" && overlapsLocked(entry.startTime, entry.durationMinutes, daySights)) continue;
      const returnTransport = entry.title === "去车站" || entry.title.startsWith("返回");
      if (!returnTransport && overlapsLocked(entry.startTime, entry.durationMinutes, dayLocked)) continue;
      generated.push(entry);
    }
  }
  const retargetError = retargetGeneratedReturn(generated, lockedKeep, days);
  if (retargetError) return { ops: [], droppedManual: false, error: retargetError };
  const fitted = generated.find((item) => item.dayIndex === days && item.title.startsWith("返回"));
  if (fitted) {
    const cutoff = (parseTime(fitted.startTime) ?? 0) - 60;
    for (const sight of keptSights) {
      if (sight.locked || sight.dayIndex !== days) continue;
      if (hitsCutoff(sight, cutoff)) keptSightIds.delete(sight.id);
    }
  }

  const preserved: RoadbookItem[] = [];
  const keptGenerated = generated.map((item) => item);
  for (const item of addedCandidates) {
    const sameDayLocked = lockedKeep.filter((locked) => locked.dayIndex === item.dayIndex);
    if (overlapsLocked(item.startTime, item.durationMinutes, sameDayLocked)) continue;
    const conflicts = keptGenerated.filter(
      (entry) => entry.dayIndex === item.dayIndex && overlapsItem(item.startTime, item.durationMinutes, entry),
    );
    const blocksCore = conflicts.some((entry) => entry.type === "景点" || entry.type === "交通" || entry.type === "餐");
    if (blocksCore) continue;
    for (const entry of conflicts) {
      const index = keptGenerated.indexOf(entry);
      if (index >= 0) keptGenerated.splice(index, 1);
    }
    if (item.type === "景点") {
      for (let index = keptGenerated.length - 1; index >= 0; index -= 1) {
        const entry = keptGenerated[index];
        if (entry?.dayIndex === item.dayIndex && entry.type === "景点" && entry.title === item.title) {
          keptGenerated.splice(index, 1);
        }
      }
    }
    preserved.push(item);
  }

  const preservedIds = new Set(preserved.map((item) => item.id));
  const keptTransport = new Set<string>();
  const keptStation = explicitReturn && existingReturn ? stationFor(book, existingReturn) : undefined;
  if (explicitReturn && existingReturn) {
    keptTransport.add(existingReturn.id);
    if (keptStation) keptTransport.add(keptStation.id);
  }
  const moveKeptTransport = (ops: PatchOp[]) => {
    if (!explicitReturn || !existingReturn) return;
    if (existingReturn.dayIndex !== days) {
      if (existingReturn.locked) ops.push({ op: "update", id: existingReturn.id, fields: { locked: false } });
      ops.push({ op: "update", id: existingReturn.id, fields: { dayIndex: days } });
      if (existingReturn.locked) ops.push({ op: "update", id: existingReturn.id, fields: { locked: true } });
    }
    if (keptStation && keptStation.dayIndex !== days) {
      ops.push({ op: "update", id: keptStation.id, fields: { dayIndex: days } });
    }
  };
  const pack = (keepIds: Set<string>, additions: RoadbookItem[]) => {
    const removed = book.items.filter(
      (item) => !item.locked && !keepIds.has(item.id) && !keptSightIds.has(item.id) && !keptTransport.has(item.id),
    );
    const ops: PatchOp[] = removed.map((item) => ({ op: "remove", id: item.id }));
    for (const entry of additions) ops.push({ op: "add", item: entry });
    moveKeptTransport(ops);
    return { removed, ops };
  };
  const withKept = pack(preservedIds, keptGenerated);
  const trial = projectPatch(book, { label: "修改天数", kind: "assumption", ops: withKept.ops });
  if (trial.ok || preserved.length === 0) {
    return {
      ops: withKept.ops,
      droppedManual: withKept.removed.some((item) => manual.has(item.id)),
    };
  }
  const fallback = pack(new Set(), generated);
  return {
    ops: fallback.ops,
    droppedManual: fallback.removed.some((item) => manual.has(item.id)),
  };
}

function parseMoveClock(raw: string): string | null {
  const text = raw.trim();
  const colon = /^(\d{1,2})[:：](\d{2})$/.exec(text);
  if (colon?.[1] && colon[2]) return clock(colon[1], colon[2]);
  const half = /^(\d{1,2}|[零〇一二两俩三四五六七八九十]+)\s*点半$/.exec(text);
  if (half?.[1]) {
    const token = half[1] === "俩" ? "两" : half[1];
    const hour = /^\d+$/.test(token) ? Number(token) : parseZhNumber(token);
    if (hour == null) return null;
    return clock(String(hour), "30");
  }
  const point = /^(\d{1,2}|[零〇一二两俩三四五六七八九十]+)\s*点(?:\s*(\d{1,2})\s*分?)?$/.exec(text);
  if (!point?.[1]) return null;
  const token = point[1] === "俩" ? "两" : point[1];
  const hour = /^\d+$/.test(token) ? Number(token) : parseZhNumber(token);
  if (hour == null) return null;
  return clock(String(hour), point[2]);
}

/** A named retime is the user's own edit, including a locked sight. Rain and rearrange still leave locks alone. */
function userMayRetimed(_book: Roadbook, _item: RoadbookItem): boolean {
  return true;
}

function matchTripDays(raw: string): number | null | undefined {
  const match =
    /^(?:(?:把|将)?(?:天数|行程)?(?:改成|改为|换成|调整为|调整成|设为|设成)\s*)?(?:(只玩|就玩|要玩|玩)|(只|就))?\s*(\d+|[零〇一二两三四五六七八九十]+)\s*(天|日)(就行了?|就好了?|就可以了?|就够了|够了|即可)?$/.exec(
      raw,
    );
  if (!match?.[3] || !match[4]) return undefined;
  if (match[4] === "日" && !match[1] && !match[5]) return undefined;
  const count = parseZhNumber(match[3]);
  return count == null ? null : count;
}

function matchWeekdayLabel(raw: string): string | null {
  const match =
    /^(?:(?:把|将)?(?:时间|日期)?(?:改成|改为|换成|调整为|改到|设为|设成)\s*)?(?:周|星期|礼拜)([一二三四五六日天])(?:出发|去|走)?$/.exec(
      raw,
    );
  if (!match?.[1]) return null;
  return `周${match[1] === "天" ? "日" : match[1]}`;
}

function resolveWhenStart(value: string, now: Date): string | null {
  const iso = /(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/.exec(value);
  if (iso?.[0]) return iso[0];
  if (isUnsetWhen(value)) return inferStartDate(null, now);
  const weekday = inferWeekdayDate(value, now);
  if (weekday) return weekday;
  if (/今天|今日|今晚|明天|明日|后天/.test(value)) return inferStartDate(value, now);
  return null;
}

function planReturnClock(book: Roadbook, item: RoadbookItem, startTime: string): Plan {
  const startMin = parseTime(startTime);
  if (startMin == null) return { request: null, note: "这个时间无法解析。" };
  const cutoff = startMin >= 60 ? startMin - 60 : startMin;
  const station = stationItem(book, item.dayIndex) ?? stationItem(book);
  const dayItems = book.items.filter(
    (entry) => entry.dayIndex === item.dayIndex && entry.id !== item.id && entry.id !== station?.id,
  );
  const blocked = dayItems.filter((entry) => entry.locked && hitsCutoff(entry, cutoff));
  if (blocked.length > 0) {
    const names = blocked.map((entry) => entry.title).join("、");
    return { request: null, note: `「${names}」已锁定，和 ${startTime} 的返程冲突，这次没有改。` };
  }
  const dropped: string[] = [];
  const ops: PatchOp[] = [];
  for (const entry of dayItems) {
    if (entry.locked || !hitsCutoff(entry, cutoff)) continue;
    const entryStart = parseTime(entry.startTime) ?? 0;
    const room = cutoff - entryStart;
    if (entryStart < cutoff && room >= 30) {
      ops.push({ op: "update", id: entry.id, fields: { durationMinutes: room } });
      continue;
    }
    dropped.push(entry.title);
    ops.push({ op: "remove", id: entry.id });
  }
  if (item.locked) ops.push({ op: "update", id: item.id, fields: { locked: false } });
  const ride = item.travelEstimateMinutes ?? item.durationMinutes;
  ops.push({
    op: "update",
    id: item.id,
    fields: {
      startTime,
      note: noteForPlacedClock(USER_CLOCK_NOTE, startTime, ride),
      source: { kind: "推断", note: USER_CLOCK_SOURCE },
    },
  });
  ops.push({ op: "update", id: item.id, fields: { locked: true } });
  if (station && startMin >= 60) {
    const stationTime = formatTime(startMin - 60);
    if (station.startTime !== stationTime) ops.push({ op: "update", id: station.id, fields: { startTime: stationTime } });
  }
  const note =
    dropped.length > 0
      ? `「${item.title}」改到 ${startTime}。已拿掉${dropped.join("、")}。`
      : `「${item.title}」改到 ${startTime}。`;
  const assumptions = book.assumptions.map((entry) =>
    entry.key === "return"
      ? {
          ...entry,
          value: `你改到第 ${item.dayIndex} 天 ${startTime}`,
          inferred: false,
          detail: "这个钟点是你改的",
        }
      : entry,
  );
  return {
    request: {
      label: `${item.title}改到${startTime}`,
      kind: "user",
      ops,
      assumptions,
      statusNote: note,
    },
    note,
  };
}

export function planMessage(book: Roadbook, text: string, random?: () => string, now = new Date()): Plan {
  const raw = text.trim().replace(/[。！？!?\s吧啊呀]+$/g, "");
  if (!raw) return { request: null, note: "先写一句要改的地方。" };
  if (book.question && !/删除|去掉|锁定|完成|改到/.test(raw)) {
    return { request: null, note: "" };
  }
  const unlock = raw.match(/^(?:解锁|取消锁定)\s*(.+)$/);
  if (unlock?.[1]) {
    const item = findItem(book, unlock[1]);
    if (!item) return { request: null, note: "没有找到要解锁的项。" };
    if (!item.locked) return { request: null, note: `「${item.title}」没有锁定。` };
    return {
      request: {
        label: `解锁${item.title}`,
        kind: "user",
        ops: [{ op: "update", id: item.id, fields: { locked: false } }],
        statusNote: `已解锁「${item.title}」。之后可以再改时间和内容。`,
      },
      note: `已解锁「${item.title}」。`,
    };
  }
  const remove = raw.match(/^(?:删除|去掉|取消)\s*(.+)$/);
  if (remove?.[1]) {
    const item = findItem(book, remove[1]);
    if (!item) return { request: null, note: "没有找到要删的项。" };
    if (item.locked) return { request: null, note: `「${item.title}」已锁定，不能改。` };
    return {
      request: {
        label: `删除${item.title}`,
        kind: "user",
        ops: [{ op: "remove", id: item.id }],
        statusNote: `已去掉「${item.title}」。`,
      },
      note: `已去掉「${item.title}」。`,
    };
  }
  const lock = raw.match(/^锁定\s*(.+)$/);
  if (lock?.[1]) {
    const item = findItem(book, lock[1]);
    if (!item) return { request: null, note: "没有找到要锁定的项。" };
    if (item.locked) return { request: null, note: `「${item.title}」已经锁定。` };
    return {
      request: {
        label: `锁定${item.title}`,
        kind: "user",
        ops: [{ op: "update", id: item.id, fields: { locked: true } }],
        statusNote: `已锁定「${item.title}」。之后的重排不会动它。`,
      },
      note: `已锁定「${item.title}」。`,
    };
  }
  const done = raw.match(/^(?:完成|做完了|做完)\s*(.+)$/);
  if (done?.[1]) {
    const item = findItem(book, done[1]);
    if (!item) return { request: null, note: "没有找到这一项。" };
    return {
      request: {
        label: `完成${item.title}`,
        kind: "user",
        ops: [{ op: "update", id: item.id, fields: { status: "已完成" } }],
        statusNote: `「${item.title}」标成已完成。`,
      },
      note: `「${item.title}」标成已完成。`,
    };
  }
  const move = raw.match(
    /^把\s*(.+?)\s*改到\s*(\d{1,2}[:：]\d{2}|\d{1,2}\s*点半|[零〇一二两俩三四五六七八九十]+\s*点半|\d{1,2}\s*点(?:\s*\d{1,2}\s*分?)?|[零〇一二两俩三四五六七八九十]+\s*点(?:\s*\d{1,2}\s*分?)?)$/,
  );
  if (move?.[1] && move[2]) {
    const item = /返程|回程/.test(move[1]) ? returnLeg(book) : findItem(book, move[1]);
    if (!item) return { request: null, note: "没有找到要改时间的项。" };
    if (!userMayRetimed(book, item)) return { request: null, note: `「${item.title}」已锁定，不能改。` };
    const startTime = parseMoveClock(move[2]);
    if (!startTime) return { request: null, note: "这个时间无法解析。" };
    if (returnLeg(book)?.id === item.id) return planReturnClock(book, item, startTime);
    const ops: PatchOp[] = [];
    if (item.locked) ops.push({ op: "update", id: item.id, fields: { locked: false } });
    ops.push({ op: "update", id: item.id, fields: { startTime } });
    if (item.locked) ops.push({ op: "update", id: item.id, fields: { locked: true } });
    return {
      request: {
        label: `${item.title}改到${startTime}`,
        kind: "user",
        ops,
        statusNote: `「${item.title}」改到 ${startTime}。`,
      },
      note: `「${item.title}」改到 ${startTime}。`,
    };
  }
  const dayCount = matchTripDays(raw);
  if (dayCount !== undefined) {
    const assumption = assumptionOf(book, "days");
    if (!assumption) return { request: null, note: "没有天数假设。" };
    if (dayCount == null || dayCount < 1) return { request: null, note: "天数请写成 1 到 7。" };
    return planAssumptionEdit(book, assumption.id, `${dayCount} 天`, random, now);
  }
  const partyMention = raw.match(
    /^(?:(?:把|将)?(?:人数)?(?:改成|改为|换成|调整为|调整成|设为|设成)\s*)?(\d+|[一二两俩三四五六七八九十]+)\s*个?人$/,
  );
  if (partyMention?.[1]) {
    const assumption = assumptionOf(book, "party");
    if (!assumption) return { request: null, note: "没有人数假设。" };
    const token = partyMention[1] === "俩" ? "两" : partyMention[1];
    const count = parseZhNumber(token);
    if (count == null || count < 1 || count > 20) return { request: null, note: "人数没有看懂。" };
    return planAssumptionEdit(book, assumption.id, partyValue(count), random, now);
  }
  const weekday = matchWeekdayLabel(raw);
  if (weekday) {
    const assumption = assumptionOf(book, "when");
    if (!assumption) return { request: null, note: "没有时间假设。" };
    return planAssumptionEdit(book, assumption.id, weekday, random, now);
  }
  return { request: null, note: "" };
}

export function planAssumptionEdit(
  book: Roadbook,
  assumptionId: string,
  rawValue: string,
  random?: () => string,
  now = new Date(),
): Plan {
  const current = book.assumptions.find((item) => item.id === assumptionId);
  if (!current) return { request: null, note: "没有这条假设。" };
  const value = rawValue.trim().slice(0, 80);
  if (!value) return { request: null, note: "假设不能为空。" };
  let assumptions = book.assumptions.map((item) =>
    item.id === assumptionId ? { ...item, value, inferred: false, detail: HAND_EDITED_DETAIL } : { ...item },
  );
  const ops: PatchOp[] = [];
  let title = book.title;
  let droppedManual = false;
  if (current.key === "days") {
    const token = value.match(/(\d+|[零〇一二两三四五六七八九十]+)/);
    const days = token?.[1] ? parseZhNumber(token[1]) : null;
    if (days == null || days < 1 || days > 7) return { request: null, note: "天数请写成 1 到 7。" };
    const maxDay = book.items.reduce((max, item) => Math.max(max, item.dayIndex), 1);
    if (days !== maxDay) {
      const back = returnLeg(book);
      const lengtheningPastThree = days > 3 && days > maxDay;
      if (back?.locked && !lengtheningPastThree) {
        return { request: null, note: `返程已锁定在第 ${back.dayIndex} 天，要先改返程吗？` };
      }
      const blocked = book.items.filter((item) => item.locked && item.id !== back?.id && item.dayIndex > days);
      if (blocked.length > 0) return { request: null, note: "多出来的日子里有锁定项，不能缩短。" };
      const rebuilt = rebuildForDayCount(book, days, random);
      if (rebuilt.error) return { request: null, note: rebuilt.error };
      ops.push(...rebuilt.ops);
      droppedManual = rebuilt.droppedManual;
    }
    title = book.title.replace(/\d+\s*天/, `${days} 天`);
    const removed = new Set(ops.filter((op) => op.op === "remove").map((op) => op.id));
    const addedReturn = ops.find((op) => op.op === "add" && op.item.type === "交通" && op.item.title.startsWith("返回"));
    const surviving = book.items.find(
      (item) => (item.title.startsWith("返回") || item.type === "交通") && !removed.has(item.id) && returnLeg(book)?.id === item.id,
    );
    const moved = ops.find((op) => op.op === "update" && op.id === surviving?.id && op.fields.startTime);
    const returnClock =
      (addedReturn && addedReturn.op === "add" ? addedReturn.item.startTime : null) ??
      (moved && moved.op === "update" ? moved.fields.startTime : null) ??
      surviving?.startTime ??
      "18:00";
    const stillThere = Boolean(addedReturn) || Boolean(surviving);
    assumptions = assumptions.map((item) => {
      if (item.key !== "return" || !canRefreshReturnChip(item)) return item;
      if (!stillThere) {
        return { ...item, value: SKIPPED_RETURN_VALUE, inferred: false, detail: SKIPPED_RETURN_DETAIL };
      }
      const nextValue = returnAssumptionValue(book.brief, days, returnClock);
      if (item.inferred) return { ...item, value: nextValue };
      return { ...item, value: nextValue, inferred: true, detail: returnEstimateNote(book.brief) };
    });
  }
  let startDate: string | undefined;
  if (current.key === "when") {
    startDate = resolveWhenStart(value, now) ?? undefined;
  }
  if (current.key === "city") {
    title = book.title.replace(/^[^·]+/, value);
  }
  const note = droppedManual
    ? `已改「${current.label}」。${REGEN_NOTICE}`
    : `已改「${current.label}」。行程按补丁更新，没有整份重写。`;
  return {
    request: {
      label: `修改${current.label}`,
      kind: "assumption",
      ops,
      assumptions,
      title,
      city: current.key === "city" ? value.replace(/（.*$/, "").trim() : undefined,
      startDate,
      statusNote: note,
    },
    note,
  };
}

export function summarizeChanges(changed: number, removed: number, days: string | undefined, dayRewrite: boolean): string {
  const body = [changed > 0 ? `改了 ${changed} 项` : "", removed > 0 ? `拿掉 ${removed} 项` : ""].filter(Boolean).join("，");
  if (dayRewrite && days) return `已按 ${days}重排：${body}`;
  return body;
}

export function planAnswer(book: Roadbook, text: string, random?: () => string): Plan {
  const answer = text.trim();
  if (!answer) return { request: null, note: "先写城市。" };
  if (!book.question) return planMessage(book, answer);
  const rebuilt = buildDraft(`${answer}。${book.brief}`, {
    id: book.id,
    random,
  });
  if (rebuilt.question) return { request: null, note: "还是没认出城市。写一个城市名就行，比如杭州。" };
  const ops: PatchOp[] = [];
  for (const item of book.items) {
    if (item.locked) continue;
    ops.push({ op: "remove", id: item.id });
  }
  const nextRandom = random ?? (() => Math.random().toString(36).slice(2, 8));
  for (const item of rebuilt.items) {
    ops.push({ op: "add", item: { ...item, id: `i_${nextRandom()}` } });
  }
  const note = `已按「${rebuilt.city}」补上草稿。锁定项还在。`;
  return {
    request: {
      label: "补上目的地",
      kind: "assumption",
      ops,
      assumptions: rebuilt.assumptions,
      title: rebuilt.title,
      city: rebuilt.city,
      startDate: rebuilt.startDate,
      setQuestion: null,
      statusNote: note,
    },
    note,
  };
}
