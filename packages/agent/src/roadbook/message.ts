import { citiesInText } from "@lushu/tools/place";
import { buildDraft, itemsForDay, repeatRequested } from "./draft";
import { parseZhNumber } from "../parse";
import { projectPatch } from "./patch";
import { inferWeekdayDate, parseTime } from "./time";
import type { PatchOp, Plan, Roadbook, RoadbookItem } from "./types";

const REGEN_NOTICE = "未锁定的改动已重排。";

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

function rebuildForDayCount(
  book: Roadbook,
  days: number,
  random?: () => string,
): { ops: PatchOp[]; droppedManual: boolean } {
  const manual = manuallyTouchedIds(book);
  const added = userAddedIds(book);
  const lockedKeep = book.items.filter((item) => item.locked && item.dayIndex <= days);
  const addedCandidates = book.items.filter(
    (item) => added.has(item.id) && !item.locked && item.dayIndex >= 1 && item.dayIndex <= days,
  );
  const origin = tripOrigin(book);
  const landmark = citiesInText(book.brief).find((hit) => hit.city === book.city)?.landmark ?? null;
  const next = random ?? (() => Math.random().toString(36).slice(2, 8));
  const used = new Map<string, number>();
  for (const item of lockedKeep) {
    if (item.type !== "景点") continue;
    used.set(item.title, (used.get(item.title) ?? 0) + 1);
  }
  const generated: RoadbookItem[] = [];
  for (let day = 1; day <= days; day += 1) {
    const dayLocked = lockedKeep.filter((item) => item.dayIndex === day);
    for (const entry of itemsForDay(book.city, day, days, next, {
      origin,
      withReturn: Boolean(origin) && days <= 3,
      mustVisit: landmark,
      used,
      allowRepeat: repeatRequested(book.brief),
    })) {
      if (dayLocked.some((item) => item.title === entry.title)) continue;
      if (overlapsLocked(entry.startTime, entry.durationMinutes, dayLocked)) continue;
      generated.push(entry);
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
  const pack = (keepIds: Set<string>, additions: RoadbookItem[]) => {
    const removed = book.items.filter((item) => !item.locked && !keepIds.has(item.id));
    const ops: PatchOp[] = removed.map((item) => ({ op: "remove", id: item.id }));
    for (const entry of additions) ops.push({ op: "add", item: entry });
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
  const move = raw.match(/^把\s*(.+?)\s*改到\s*(\d{1,2})(?:[:：](\d{2})|点(?:(\d{2})分?)?)?$/);
  if (move?.[1] && move[2]) {
    const item = findItem(book, move[1]);
    if (!item) return { request: null, note: "没有找到要改时间的项。" };
    if (item.locked) return { request: null, note: `「${item.title}」已锁定，不能改。` };
    const startTime = clock(move[2], move[3] ?? move[4]);
    if (!startTime) return { request: null, note: "这个时间无法解析。" };
    return {
      request: {
        label: `${item.title}改到${startTime}`,
        kind: "user",
        ops: [{ op: "update", id: item.id, fields: { startTime } }],
        statusNote: `「${item.title}」改到 ${startTime}。重叠的项会顺一下。`,
      },
      note: `「${item.title}」改到 ${startTime}。`,
    };
  }
  const daysMention = raw.match(
    /^(?:(?:把|将)?(?:天数)?(?:改成|改为|换成|调整为|调整成|设为|设成)\s*)?(\d+|[零〇一二两三四五六七八九十]+)\s*天$/,
  );
  if (daysMention?.[1]) {
    const assumption = assumptionOf(book, "days");
    if (!assumption) return { request: null, note: "没有天数假设。" };
    const count = parseZhNumber(daysMention[1]);
    if (count == null) return { request: null, note: "天数请写成 1 到 7。" };
    return planAssumptionEdit(book, assumption.id, `${count} 天`, random, now);
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
  if (/^(?:(?:把|将)?(?:时间|日期)?(?:改成|改为|换成|调整为|改到|设为|设成)\s*)?(?:周六|星期六|礼拜六)(?:出发|去|走)?$/.test(raw)) {
    const assumption = assumptionOf(book, "when");
    if (!assumption) return { request: null, note: "没有时间假设。" };
    return planAssumptionEdit(book, assumption.id, "周六", random, now);
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
  const assumptions = book.assumptions.map((item) =>
    item.id === assumptionId ? { ...item, value, inferred: false, detail: "已手动修改" } : { ...item },
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
      const blocked = book.items.filter((item) => item.locked && item.dayIndex > days);
      if (blocked.length > 0) return { request: null, note: "多出来的日子里有锁定项，不能缩短。" };
      const rebuilt = rebuildForDayCount(book, days, random);
      ops.push(...rebuilt.ops);
      droppedManual = rebuilt.droppedManual;
    }
    title = book.title.replace(/\d+\s*天/, `${days} 天`);
  }
  let startDate: string | undefined;
  if (current.key === "when") {
    startDate = inferWeekdayDate(value, now) ?? undefined;
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
