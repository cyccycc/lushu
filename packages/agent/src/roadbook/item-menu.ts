import { guideFor } from "../cities";
import { planDeleteItem, planMoveItem } from "./message";
import type { Plan, Roadbook, RoadbookItem } from "./types";

export type ItemMenuActionId = "swap" | "move" | "delete" | "why" | "lock" | "unlock";

export type ItemMenuAction = {
  id: ItemMenuActionId;
  label: string;
  enabled: boolean;
  /** Shown when the action is gray, for example 需要模型密钥. */
  hint?: string;
};

export type ItemMenu = {
  /** 去车站 only offers 为什么. */
  whyOnly: boolean;
  actions: ItemMenuAction[];
  why: string;
  /** Unlocking a brief-stated lock (体检, 开会, 来自你的原话) needs a confirm. */
  unlockNeedsConfirm: boolean;
};

function findItem(book: Roadbook, itemId: string): RoadbookItem | undefined {
  return book.items.find((item) => item.id === itemId);
}

export function briefLock(item: RoadbookItem): boolean {
  const blob = `${item.note ?? ""} ${item.source.note ?? ""}`;
  if (blob.includes("来自你的原话")) return true;
  return /体检|开会|会议/.test(item.title);
}

export function whyForItem(item: RoadbookItem): string {
  const parts = [item.note, item.source.note].filter((part): part is string => Boolean(part && part.trim()));
  if (parts.length === 0) return `${item.source.kind}。没有更多说明。`;
  return parts.join("");
}

function usedTitles(book: Roadbook): Set<string> {
  return new Set(book.items.map((item) => item.title));
}

export function cityTemplateNames(city: string): string[] {
  return guideFor(city).places.map((place) => place.name);
}

/** Next unused same-city template sight, or null when the guide has nothing left. */
export function swapCandidate(book: Roadbook, item: RoadbookItem): { name: string; area: string; detail: string; indoor: boolean } | null {
  if (item.type !== "景点" || item.title === "去车站") return null;
  const used = usedTitles(book);
  const place = guideFor(book.city).places.find((entry) => entry.name !== item.title && !used.has(entry.name));
  if (!place) return null;
  return { name: place.name, area: place.area, detail: place.detail, indoor: place.indoor };
}

export function describeItemMenu(book: Roadbook, itemId: string, hasModelKey: boolean): ItemMenu | string {
  const item = findItem(book, itemId);
  if (!item) return "没有这一项。";
  const why = whyForItem(item);
  if (item.title === "去车站") {
    return {
      whyOnly: true,
      why,
      unlockNeedsConfirm: false,
      actions: [{ id: "why", label: "为什么安排这个", enabled: true }],
    };
  }
  const locked = item.locked;
  const candidate = swapCandidate(book, item);
  let swapHint: string | undefined;
  if (locked) swapHint = "先解锁";
  else if (!candidate) swapHint = hasModelKey ? "没有可换的景点" : "需要模型密钥";
  return {
    whyOnly: false,
    why,
    unlockNeedsConfirm: locked && briefLock(item),
    actions: [
      { id: "swap", label: "换一个", enabled: !locked && Boolean(candidate), hint: swapHint },
      { id: "move", label: "挪时间", enabled: !locked, hint: locked ? "先解锁" : undefined },
      { id: "delete", label: "删掉", enabled: !locked, hint: locked ? "先解锁" : undefined },
      { id: "why", label: "为什么安排这个", enabled: true },
      locked
        ? { id: "unlock", label: "解锁", enabled: true }
        : { id: "lock", label: "锁定必去", enabled: true },
    ],
  };
}

export function planItemSwap(book: Roadbook, itemId: string): Plan {
  const item = findItem(book, itemId);
  if (!item) return { request: null, note: "没有这一项。" };
  if (item.title === "去车站") return { request: null, note: "去车站不能换。" };
  if (item.locked) return { request: null, note: `「${item.title}」已锁定，先解锁再换。` };
  const next = swapCandidate(book, item);
  if (!next) return { request: null, note: "需要模型密钥" };
  const place = book.city === "未写明的目的地" ? next.area : `${book.city} · ${next.area}`;
  const note = `已换成「${item.title}」。${next.detail}`;
  return {
    request: {
      label: `${item.title}换成${next.name}`,
      kind: "user",
      ops: [
        {
          op: "update",
          id: item.id,
          fields: {
            title: next.name,
            place,
            indoor: next.indoor,
            note,
            source: { kind: "推断", note: "同城模板" },
          },
        },
      ],
      statusNote: `「${item.title}」换成「${next.name}」。`,
    },
    note: `「${item.title}」换成「${next.name}」。`,
  };
}

export function planItemMove(book: Roadbook, itemId: string, startTime: string): Plan {
  return planMoveItem(book, itemId, startTime);
}

export function planItemDelete(book: Roadbook, itemId: string): Plan {
  return planDeleteItem(book, itemId);
}

/** Existing lock plus priority 必去. Not a second lock flag. */
export function planLockMust(book: Roadbook, itemId: string): Plan {
  const item = findItem(book, itemId);
  if (!item) return { request: null, note: "没有这一项。" };
  if (item.title === "去车站") return { request: null, note: "去车站只说明为什么。" };
  if (item.locked && item.priority === "必去") return { request: null, note: `「${item.title}」已经锁定为必去。` };
  return {
    request: {
      label: `锁定${item.title}`,
      kind: "user",
      ops: [{ op: "update", id: item.id, fields: { locked: true, priority: "必去" } }],
      statusNote: `已锁定「${item.title}」，并标成必去。重排不会动它。`,
    },
    note: `已锁定「${item.title}」，并标成必去。`,
  };
}

/** Clears the lock only. Priority stays. Brief-stated locks need confirmed: true. */
export function planItemUnlock(book: Roadbook, itemId: string, confirmed = false): Plan {
  const item = findItem(book, itemId);
  if (!item) return { request: null, note: "没有这一项。" };
  if (!item.locked) return { request: null, note: `「${item.title}」没有锁定。` };
  if (briefLock(item) && !confirmed) {
    return { request: null, note: "这是原话里的安排。解锁后重排可以改它。" };
  }
  return {
    request: {
      label: `解锁${item.title}`,
      kind: "user",
      ops: [{ op: "update", id: item.id, fields: { locked: false } }],
      statusNote: `已解锁「${item.title}」。优先级还是${item.priority}。`,
    },
    note: `已解锁「${item.title}」。`,
  };
}
