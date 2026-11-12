import { guideFor, type Place } from "../cities";
import { applyPatch, retainMainPlans } from "./patch";
import { shanghaiDate, targetDayIndex } from "./time";
import {
  ROADBOOK_STYLES,
  STYLE_CONFIRM,
  type MainPlanSnapshot,
  type PatchOp,
  type Roadbook,
  type RoadbookItem,
  type RoadbookStyle,
} from "./types";

export type StyleName = RoadbookStyle | "main";

export type StyleChoice = {
  id: RoadbookStyle;
  label: string;
  enabled: boolean;
  current: boolean;
  hint?: string;
};

export type StyleApplyResult =
  | { ok: true; book: Roadbook }
  | { ok: false; confirm: true; note: string; book: Roadbook }
  | { ok: false; confirm: false; error: string; book: Roadbook };

const MONEY_SAVED = /省了\s*\d|省了[^。\n]{0,12}元/;

function cloneItem(item: RoadbookItem): RoadbookItem {
  return { ...item, source: { ...item.source }, highlight: false };
}

function inScope(book: Roadbook, item: RoadbookItem, now: Date): boolean {
  if (item.status === "已完成" || item.locked || item.title === "去车站") return false;
  if (shanghaiDate(now) < book.startDate) return true;
  const target = targetDayIndex(book, now);
  if (target.outOfRange) return false;
  return item.dayIndex >= target.dayIndex;
}

function guidePlace(city: string, title: string): Place | undefined {
  return guideFor(city).places.find((place) => place.name === title || title.includes(place.name));
}

function unusedFreePlace(book: Roadbook, used: Set<string>): Place | undefined {
  return guideFor(book.city).places.find((place) => {
    if (used.has(place.name)) return false;
    if (place.cost === "mid") return false;
    return place.cost === "free" || place.cost == null || (place.cost === "low" && !place.detail.includes("门票"));
  });
}

function cheapNote(previous: string): string {
  return `更省钱。原来是「${previous}」。改去不收门票的地方，这段也可以改坐公交，不打车。`;
}

function relax(items: RoadbookItem[], book: Roadbook, now: Date): RoadbookItem[] {
  return items.flatMap((item) => {
    if (!inScope(book, item, now)) return [item];
    if (item.priority === "可砍" && (item.type === "自由" || item.type === "景点")) return [];
    if (item.type !== "景点" || item.durationMinutes <= 75) return [item];
    return [
      {
        ...item,
        durationMinutes: 75,
        travelEstimateMinutes: item.travelEstimateMinutes == null ? null : Math.min(item.travelEstimateMinutes, 15),
        note: "更轻松。少排一点，缩短停留。",
        source: { kind: "推断" as const, note: "更轻松" },
      },
    ];
  });
}

function saveMoney(items: RoadbookItem[], book: Roadbook, now: Date): RoadbookItem[] {
  const used = new Set(items.map((item) => item.title));
  return items.map((item) => {
    if (!inScope(book, item, now) || item.type !== "景点") return item;
    const known = guidePlace(book.city, item.title);
    const paid = known?.cost === "mid" || (item.note ?? "").includes("门票");
    if (!paid) return item;
    const next = unusedFreePlace(book, used);
    if (!next) {
      return {
        ...item,
        travelEstimateMinutes: item.travelEstimateMinutes == null ? 15 : Math.min(item.travelEstimateMinutes, 20),
        note: `更省钱。${item.title}先留着。去的时候改坐公交，不打车。`,
        source: { kind: "推断" as const, note: "更省钱" },
      };
    }
    used.add(next.name);
    return {
      ...item,
      title: next.name,
      place: `${book.city} · ${next.area}`,
      indoor: next.indoor,
      note: cheapNote(item.title),
      source: { kind: "推断" as const, note: "更省钱" },
    };
  });
}

function rainy(items: RoadbookItem[], book: Roadbook, now: Date): RoadbookItem[] {
  const used = new Set(items.map((item) => item.title));
  const indoor = guideFor(book.city).places.filter((place) => place.indoor);
  return items.map((item) => {
    if (!inScope(book, item, now) || item.type !== "景点" || item.indoor) return item;
    const alt = indoor.find((place) => !used.has(place.name));
    if (alt && item.priority !== "必去") {
      used.add(alt.name);
      return {
        ...item,
        title: alt.name,
        place: `${book.city} · ${alt.area}`,
        indoor: true,
        durationMinutes: Math.min(item.durationMinutes, 90),
        note: `雨天版。原来是「${item.title}」。${alt.detail}`,
        source: { kind: "推断" as const, note: "雨天版" },
      };
    }
    return {
      ...item,
      note: `雨天版。${item.title}仍留在户外，去之前再看一眼。`,
      source: { kind: "推断" as const, note: "雨天版" },
    };
  });
}

function lessWalking(items: RoadbookItem[], book: Roadbook, now: Date): RoadbookItem[] {
  return items.flatMap((item) => {
    if (!inScope(book, item, now)) return [item];
    if (item.priority === "可砍" && item.type === "自由") return [];
    const longSight = item.type === "景点" && item.durationMinutes > 60;
    const longWalk = (item.travelEstimateMinutes ?? 0) > 15;
    if (!longSight && !longWalk) return [item];
    return [
      {
        ...item,
        durationMinutes: longSight ? Math.min(item.durationMinutes, 60) : item.durationMinutes,
        travelEstimateMinutes: item.travelEstimateMinutes == null ? null : Math.min(item.travelEstimateMinutes, 15),
        note: "少走路。缩短停留，少走一段。",
        source: { kind: "推断" as const, note: "少走路" },
      },
    ];
  });
}

function styledItems(items: RoadbookItem[], book: Roadbook, style: RoadbookStyle, now: Date): RoadbookItem[] {
  if (style === "更轻松") return relax(items, book, now);
  if (style === "更省钱") return saveMoney(items, book, now);
  if (style === "雨天版") return rainy(items, book, now);
  return lessWalking(items, book, now);
}

function signature(item: RoadbookItem): string {
  return JSON.stringify({
    dayIndex: item.dayIndex,
    startTime: item.startTime,
    durationMinutes: item.durationMinutes,
    title: item.title,
    place: item.place,
    type: item.type,
    status: item.status,
    source: item.source,
    travelEstimateMinutes: item.travelEstimateMinutes ?? null,
    estimateSource: item.estimateSource ?? null,
    locked: item.locked,
    priority: item.priority,
    indoor: item.indoor,
    note: item.note ?? "",
  });
}

function diffItems(current: RoadbookItem[], target: RoadbookItem[]): PatchOp[] {
  const targetById = new Map(target.map((item) => [item.id, item]));
  const ops: PatchOp[] = [];
  for (const item of current) {
    const next = targetById.get(item.id);
    if (!next) {
      if (item.locked) ops.push({ op: "update", id: item.id, fields: { locked: false } });
      ops.push({ op: "remove", id: item.id });
      continue;
    }
    if (signature(item) === signature(next)) continue;
    if (item.locked) ops.push({ op: "update", id: item.id, fields: { locked: false } });
    ops.push({
      op: "update",
      id: item.id,
      fields: {
        dayIndex: next.dayIndex,
        startTime: next.startTime,
        durationMinutes: next.durationMinutes,
        title: next.title,
        place: next.place,
        type: next.type,
        status: next.status,
        source: { ...next.source },
        travelEstimateMinutes: next.travelEstimateMinutes,
        estimateSource: next.estimateSource,
        locked: next.locked,
        priority: next.priority,
        indoor: next.indoor,
        note: next.note ?? "",
      },
    });
  }
  for (const item of target) {
    if (!current.some((currentItem) => currentItem.id === item.id)) {
      ops.push({ op: "add", item: cloneItem(item) });
    }
  }
  return ops;
}

function capture(book: Roadbook, id: string): MainPlanSnapshot {
  return {
    id,
    items: book.items.map(cloneItem),
    assumptions: book.assumptions.map((item) => ({ ...item, changed: false })),
    weather: book.weather.map((item) => ({ ...item })),
    verifyChecklist: book.verifyChecklist.map((item) => ({
      id: item.id,
      text: item.text,
      ...(item.itemId ? { itemId: item.itemId } : {}),
    })),
    title: book.title,
    city: book.city,
    startDate: book.startDate,
    question: book.question ? { ...book.question } : null,
    statusLine: book.statusLine,
  };
}

function planOf(book: Roadbook): MainPlanSnapshot | undefined {
  if (!book.mainPlanId) return undefined;
  return book.mainPlans?.find((plan) => plan.id === book.mainPlanId);
}

function baseItems(book: Roadbook): RoadbookItem[] {
  return (planOf(book)?.items ?? book.items).map(cloneItem);
}

function mergeChecks(previous: MainPlanSnapshot["verifyChecklist"], current: Roadbook["verifyChecklist"]) {
  const live = new Map(current.map((item) => [item.id, item]));
  return previous.map((item) => {
    const row = { id: item.id, text: item.text, ...(item.itemId ? { itemId: item.itemId } : {}) };
    const found = live.get(item.id);
    if (found?.checkedAt) return { ...row, checkedAt: found.checkedAt };
    return row;
  });
}

function mentionsSavedMoney(book: Roadbook): boolean {
  const blob = JSON.stringify({ items: book.items, statusLine: book.statusLine });
  return MONEY_SAVED.test(blob);
}

export function describeStyles(book: Roadbook, now = new Date()): { current: RoadbookStyle | null; choices: StyleChoice[]; showReturn: boolean } {
  const current = book.style ?? null;
  const choices = ROADBOOK_STYLES.map((style) => {
    const ops = diffItems(book.items, styledItems(baseItems(book), book, style, now));
    const enabled = style !== current && ops.length > 0;
    return {
      id: style,
      label: style,
      enabled,
      current: style === current,
      hint: enabled || style === current ? undefined : "这次改不了",
    };
  });
  return { current, choices, showReturn: current != null };
}

export function applyRoadbookStyle(book: Roadbook, style: StyleName, confirmed = false, now = new Date()): StyleApplyResult {
  if (style !== "main" && !(ROADBOOK_STYLES as readonly string[]).includes(style)) {
    return { ok: false, confirm: false, error: "没有这种风格。", book };
  }
  if (style !== "main" && book.style === style) return { ok: false, confirm: false, error: `现在就是${style}。`, book };
  if (style === "main" && !book.style) return { ok: false, confirm: false, error: "现在就是主方案。", book };
  if (book.style && book.styleDirty && !confirmed) {
    return { ok: false, confirm: true, note: STYLE_CONFIRM, book };
  }

  const base = baseItems(book);
  const target = style === "main" ? base : styledItems(base, book, style, now);
  const ops = diffItems(book.items, target);
  if (style !== "main" && ops.length === 0) return { ok: false, confirm: false, error: "这次改不了。", book };

  const applied = applyPatch(
    book,
    {
      id: `p_style_${book.patchHistory.length}_${book.undo.length}_${style}`,
      label: style === "main" ? "回到主方案" : style,
      kind: "style",
      ops,
      statusNote: style === "main" ? "已回到主方案。" : `当前是${style}。`,
    },
    now,
  );
  if (!applied.ok) return { ok: false, confirm: false, error: applied.error, book };
  let mainPlans = applied.book.mainPlans ?? [];
  let mainPlanId = book.mainPlanId ?? null;
  let plan = planOf(book);
  if (style !== "main" && !mainPlanId) {
    const id = `m_${book.patchHistory.length}_${book.updatedAt}`;
    plan = capture(book, id);
    mainPlans = [...mainPlans, plan];
    mainPlanId = id;
  }
  const nextStyle = style === "main" ? null : style;
  const nextPlanId = style === "main" ? null : mainPlanId;
  let next: Roadbook = {
    ...applied.book,
    mainPlans,
    style: nextStyle,
    mainPlanId: nextPlanId,
    styleDirty: false,
    verifyChecklist: plan ? mergeChecks(plan.verifyChecklist, applied.book.verifyChecklist) : applied.book.verifyChecklist,
  };
  next = retainMainPlans(next);
  if (mentionsSavedMoney(next)) return { ok: false, confirm: false, error: "更省钱不能写省了多少钱。", book };
  return { ok: true, book: next };
}
