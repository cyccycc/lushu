import { buildDraft, itemsForDay } from "./draft";
import { parseZhNumber } from "../parse";
import type { PatchOp, Plan, Roadbook, RoadbookItem } from "./types";

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

export function planMessage(book: Roadbook, text: string): Plan {
  const raw = text.trim();
  if (!raw) return { request: null, note: "先写一句要改的地方。" };
  if (book.question && !/删除|去掉|锁定|完成|改到/.test(raw)) {
    return { request: null, note: "" };
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
    if (item.locked) return { request: null, note: `「${item.title}」已锁定，不能改。` };
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
  return { request: null, note: "" };
}

export function planAssumptionEdit(book: Roadbook, assumptionId: string, rawValue: string, random?: () => string): Plan {
  const current = book.assumptions.find((item) => item.id === assumptionId);
  if (!current) return { request: null, note: "没有这条假设。" };
  const value = rawValue.trim().slice(0, 80);
  if (!value) return { request: null, note: "假设不能为空。" };
  const assumptions = book.assumptions.map((item) =>
    item.id === assumptionId ? { ...item, value, inferred: false, detail: "已手动修改" } : { ...item },
  );
  const ops: PatchOp[] = [];
  let title = book.title;
  if (current.key === "days") {
    const token = value.match(/(\d+|[零〇一二两三四五六七八九十]+)/);
    const days = token?.[1] ? parseZhNumber(token[1]) : null;
    if (days == null || days < 1 || days > 7) return { request: null, note: "天数请写成 1 到 7。" };
    const maxDay = book.items.reduce((max, item) => Math.max(max, item.dayIndex), 1);
    if (days < maxDay) {
      const blocked = book.items.filter((item) => item.dayIndex > days && item.locked);
      if (blocked.length > 0) return { request: null, note: "多出来的日子里有锁定项，不能缩短。" };
      for (const item of book.items.filter((entry) => entry.dayIndex > days)) {
        ops.push({ op: "remove", id: item.id });
      }
    }
    if (days > maxDay) {
      const next = random ?? (() => Math.random().toString(36).slice(2, 8));
      for (let day = maxDay + 1; day <= days; day += 1) {
        for (const entry of itemsForDay(book.city, day, days, next, { origin: null })) {
          ops.push({ op: "add", item: entry });
        }
      }
    }
    title = book.title.replace(/\d+\s*天/, `${days} 天`);
  }
  if (current.key === "city") {
    title = book.title.replace(/^[^·]+/, value);
  }
  const note = `已改「${current.label}」。行程按补丁更新，没有整份重写。`;
  return {
    request: {
      label: `修改${current.label}`,
      kind: "assumption",
      ops,
      assumptions,
      title,
      city: current.key === "city" ? value.replace(/（.*$/, "").trim() : undefined,
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
