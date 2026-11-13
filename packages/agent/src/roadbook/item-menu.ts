import { guideFor } from "../cities";
import { userStatedErrand } from "./honesty";
import { planDeleteItem, planDurationItem, planMoveItem } from "./message";
import type { PatchRequest, Plan, Roadbook, RoadbookItem } from "./types";

export type ItemMenuActionId = "swap" | "move" | "duration" | "delete" | "why" | "lock" | "unlock";

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
  /** Unlocking a user-stated 办事, or anything marked 来自你的原话, needs a confirm. */
  unlockNeedsConfirm: boolean;
};

function findItem(book: Roadbook, itemId: string): RoadbookItem | undefined {
  return book.items.find((item) => item.id === itemId);
}

export function briefLock(item: RoadbookItem): boolean {
  const blob = `${item.note ?? ""} ${item.source.note ?? ""}`;
  if (blob.includes("来自你的原话")) return true;
  return userStatedErrand(item);
}

function whyClauses(text: string): string[] {
  return text
    .split(/[。！？!?；;]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Drop repeated sentences and join the rest with full-width periods. */
export function whyForItem(item: RoadbookItem): string {
  const parts = [item.note, item.source.note].filter((part): part is string => Boolean(part && part.trim()));
  const seen = new Set<string>();
  const clauses: string[] = [];
  for (const part of parts) {
    for (const clause of whyClauses(part)) {
      if (seen.has(clause)) continue;
      seen.add(clause);
      clauses.push(clause);
    }
  }
  if (clauses.length === 0) return `${item.source.kind}。没有更多说明。`;
  return `${clauses.join("。")}。`;
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
  const sight = item.type === "景点";
  const candidate = sight ? swapCandidate(book, item) : null;
  let swapHint: string | undefined;
  if (sight && locked) swapHint = "先解锁";
  else if (sight && !candidate && !hasModelKey) swapHint = "需要模型密钥";
  const actions: ItemMenuAction[] = [];
  if (sight) {
    actions.push({
      id: "swap",
      label: "换一个",
      enabled: !locked && (Boolean(candidate) || hasModelKey),
      hint: swapHint,
    });
  }
  return {
    whyOnly: false,
    why,
    unlockNeedsConfirm: locked && briefLock(item),
    actions: [
      ...actions,
      { id: "move", label: "挪时间", enabled: !locked, hint: locked ? "先解锁" : undefined },
      { id: "duration", label: "改时长", enabled: !locked, hint: locked ? "先解锁" : undefined },
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
  const note = `原来是「${item.title}」。${next.detail}`;
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

/** Sentence sent to the model when the city template has nothing left to swap in. */
export function modelSwapText(title: string): string {
  return `把景点「${title}」换成同城另一个还没排进这本路书的景点。只改这一项的标题、地点和备注。备注写成：原来是「${title}」。不要改锁定项，不要改其他项。`;
}

export type SwapChoice =
  | { mode: "template"; request: PatchRequest; note: string }
  | { mode: "model"; text: string }
  | { mode: "unavailable"; note: string };

/** Template swap when a same-city sight is left; otherwise the model, and only for sights. */
export function chooseItemSwap(book: Roadbook, itemId: string, hasModelKey: boolean): SwapChoice {
  const item = findItem(book, itemId);
  if (!item) return { mode: "unavailable", note: "没有这一项。" };
  if (item.type !== "景点" || item.title === "去车站") return { mode: "unavailable", note: "这项不能换。" };
  if (item.locked) return { mode: "unavailable", note: `「${item.title}」已锁定，先解锁再换。` };
  const template = planItemSwap(book, itemId);
  if (template.request) return { mode: "template", request: template.request, note: template.note };
  if (hasModelKey) return { mode: "model", text: modelSwapText(item.title) };
  return { mode: "unavailable", note: template.note || "需要模型密钥" };
}

export function planItemMove(book: Roadbook, itemId: string, startTime: string): Plan {
  return planMoveItem(book, itemId, startTime);
}

/** Menu duration. Locked items and 去车站 are refused; chat uses the same planner. */
export function planItemDuration(book: Roadbook, itemId: string, change: number | string): Plan {
  return planDurationItem(book, itemId, change);
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
