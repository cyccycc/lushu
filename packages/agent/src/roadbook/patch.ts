import { DAY_END_MINUTES, formatTime, noteForPlacedClock, parseTime } from "./time";
import {
  ITEM_STATUSES,
  ITEM_TYPES,
  PRIORITIES,
  SOURCE_KINDS,
  type AppliedPatch,
  type Assumption,
  type ItemFields,
  type ItemSource,
  type PatchOp,
  type PatchRequest,
  type PatchResult,
  type Roadbook,
  type RoadbookItem,
  type VerifyItem,
} from "./types";

const MAX_OPS = 160;

function cloneItem(item: RoadbookItem): RoadbookItem {
  return {
    ...item,
    source: { ...item.source },
    highlight: false,
  };
}

function cloneBook(book: Roadbook): Roadbook {
  return {
    ...book,
    assumptions: book.assumptions.map((item) => ({ ...item })),
    items: book.items.map(cloneItem),
    weather: book.weather.map((item) => ({ ...item })),
    verifyChecklist: book.verifyChecklist.map((item) => ({ ...item })),
    patchHistory: book.patchHistory.map((patch) => ({ ...patch, ops: patch.ops.map(cloneOp) })),
    undo: book.undo
      ? {
          ...book.undo,
          items: book.undo.items.map(cloneItem),
          assumptions: book.undo.assumptions.map((item) => ({ ...item })),
          weather: book.undo.weather.map((item) => ({ ...item })),
          verifyChecklist: book.undo.verifyChecklist.map((item) => ({ ...item })),
        }
      : null,
    question: book.question ? { ...book.question } : null,
  };
}

function cloneOp(op: PatchOp): PatchOp {
  if (op.op === "add") return { op: "add", item: cloneItem(op.item) };
  if (op.op === "update") return { op: "update", id: op.id, fields: { ...op.fields, source: op.fields.source ? { ...op.fields.source } : undefined } };
  if (op.op === "reorder") return { op: "reorder", dayIndex: op.dayIndex, ids: [...op.ids] };
  return { op: "remove", id: op.id };
}

function isEnum<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function readSource(value: unknown): ItemSource | string {
  if (!value || typeof value !== "object") return "来源缺失。";
  const raw = value as ItemSource;
  if (!isEnum(raw.kind, SOURCE_KINDS)) return "来源类型无效。";
  const source: ItemSource = { kind: raw.kind };
  if (raw.url != null) {
    if (typeof raw.url !== "string" || raw.url.length > 2000) return "来源链接无效。";
    source.url = raw.url;
  }
  if (raw.fetchedAt != null) {
    if (typeof raw.fetchedAt !== "string" || raw.fetchedAt.length > 40) return "来源时间无效。";
    source.fetchedAt = raw.fetchedAt;
  }
  if (raw.note != null) {
    if (typeof raw.note !== "string") return "来源说明无效。";
    source.note = raw.note.slice(0, 200);
  }
  return source;
}

function readCoord(value: unknown, min: number, max: number): number | null | string {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return "坐标无效。";
  return value;
}

export function normalizeItem(value: unknown, fallbackId?: string): RoadbookItem | string {
  if (!value || typeof value !== "object") return "行程项无法解析。";
  const raw = value as Partial<RoadbookItem>;
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 80) : "";
  const place = typeof raw.place === "string" ? raw.place.trim().slice(0, 80) : "";
  if (!title) return "行程项缺少标题。";
  if (!place) return "行程项缺少地点。";
  if (typeof raw.dayIndex !== "number" || !Number.isInteger(raw.dayIndex) || raw.dayIndex < 1 || raw.dayIndex > 14) {
    return `「${title}」的日序无效。`;
  }
  if (typeof raw.startTime !== "string" || parseTime(raw.startTime) == null) {
    return `「${title}」的时间无法解析。`;
  }
  if (
    typeof raw.durationMinutes !== "number" ||
    !Number.isInteger(raw.durationMinutes) ||
    raw.durationMinutes < 5 ||
    raw.durationMinutes > 600
  ) {
    return `「${title}」的时长无效。`;
  }
  if (!isEnum(raw.type, ITEM_TYPES)) return `「${title}」的类型无效。`;
  if (!isEnum(raw.status, ITEM_STATUSES)) return `「${title}」的状态无效。`;
  if (!isEnum(raw.priority, PRIORITIES)) return `「${title}」的优先级无效。`;
  const source = readSource(raw.source);
  if (typeof source === "string") return source;
  const lat = readCoord(raw.lat, -90, 90);
  if (typeof lat === "string") return lat;
  const lng = readCoord(raw.lng, -180, 180);
  if (typeof lng === "string") return lng;
  let travel: number | null = null;
  if (raw.travelEstimateMinutes != null) {
    if (
      typeof raw.travelEstimateMinutes !== "number" ||
      !Number.isInteger(raw.travelEstimateMinutes) ||
      raw.travelEstimateMinutes < 0 ||
      raw.travelEstimateMinutes > 600
    ) {
      return `「${title}」的路程分钟无效。`;
    }
    travel = raw.travelEstimateMinutes;
  }
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim().slice(0, 40) : fallbackId;
  if (!id) return "行程项缺少 id。";
  return {
    id,
    dayIndex: raw.dayIndex,
    startTime: raw.startTime.trim(),
    durationMinutes: raw.durationMinutes,
    title,
    place,
    lat,
    lng,
    type: raw.type,
    status: raw.status,
    source,
    travelEstimateMinutes: travel,
    estimateSource: raw.estimateSource === "实测" || raw.estimateSource === "检索" || raw.estimateSource === "推断"
      ? raw.estimateSource
      : "推断",
    locked: raw.locked === true,
    priority: raw.priority,
    indoor: raw.indoor === true,
    highlight: false,
    note: typeof raw.note === "string" ? raw.note.slice(0, 300) : undefined,
  };
}

function lockedUpdateError(item: RoadbookItem, fields: ItemFields): string | null {
  if (!item.locked) return null;
  for (const key of Object.keys(fields) as (keyof ItemFields)[]) {
    if (fields[key] === undefined) continue;
    if (key === "status" || key === "locked") continue;
    return `「${item.title}」已锁定，不能改。`;
  }
  return null;
}

function arrivalRide(item: RoadbookItem): number | undefined {
  if (item.title.startsWith("返回") || item.note?.includes("预计次日")) {
    return item.travelEstimateMinutes ?? item.durationMinutes;
  }
  return undefined;
}

function mayCrossMidnight(item: RoadbookItem): boolean {
  return item.title.startsWith("返回") || Boolean(item.note?.includes("预计次日"));
}

function rewritePlacedNote(item: RoadbookItem): string | undefined {
  return noteForPlacedClock(item.note, item.startTime, arrivalRide(item));
}

function applyFields(item: RoadbookItem, fields: ItemFields): string | null {
  if (fields.dayIndex != null) {
    if (!Number.isInteger(fields.dayIndex) || fields.dayIndex < 1 || fields.dayIndex > 14) return "日序无效。";
    item.dayIndex = fields.dayIndex;
  }
  if (fields.startTime != null) {
    if (parseTime(fields.startTime) == null) return `时间「${fields.startTime}」无法解析。`;
    item.startTime = fields.startTime.trim();
  }
  if (fields.durationMinutes != null) {
    if (!Number.isInteger(fields.durationMinutes) || fields.durationMinutes < 5 || fields.durationMinutes > 600) {
      return "时长无效。";
    }
    item.durationMinutes = fields.durationMinutes;
  }
  if (fields.title != null) {
    const title = fields.title.trim().slice(0, 80);
    if (!title) return "标题不能为空。";
    item.title = title;
  }
  if (fields.place != null) {
    const place = fields.place.trim().slice(0, 80);
    if (!place) return "地点不能为空。";
    item.place = place;
  }
  if (fields.lat !== undefined) {
    const lat = readCoord(fields.lat, -90, 90);
    if (typeof lat === "string") return lat;
    item.lat = lat;
  }
  if (fields.lng !== undefined) {
    const lng = readCoord(fields.lng, -180, 180);
    if (typeof lng === "string") return lng;
    item.lng = lng;
  }
  if (fields.type != null) {
    if (!isEnum(fields.type, ITEM_TYPES)) return "类型无效。";
    item.type = fields.type;
  }
  if (fields.status != null) {
    if (!isEnum(fields.status, ITEM_STATUSES)) return "状态无效。";
    item.status = fields.status;
  }
  if (fields.priority != null) {
    if (!isEnum(fields.priority, PRIORITIES)) return "优先级无效。";
    item.priority = fields.priority;
  }
  if (fields.source != null) {
    const source = readSource(fields.source);
    if (typeof source === "string") return source;
    item.source = source;
  }
  if (fields.travelEstimateMinutes !== undefined) {
    if (fields.travelEstimateMinutes == null) item.travelEstimateMinutes = null;
    else if (
      !Number.isInteger(fields.travelEstimateMinutes) ||
      fields.travelEstimateMinutes < 0 ||
      fields.travelEstimateMinutes > 600
    ) {
      return "路程分钟无效。";
    } else item.travelEstimateMinutes = fields.travelEstimateMinutes;
  }
  if (fields.estimateSource != null) {
    if (fields.estimateSource !== "实测" && fields.estimateSource !== "检索" && fields.estimateSource !== "推断") {
      return "路程来源无效。";
    }
    item.estimateSource = fields.estimateSource;
  }
  if (fields.locked != null) item.locked = fields.locked === true;
  if (fields.indoor != null) item.indoor = fields.indoor === true;
  if (fields.note != null) item.note = fields.note.slice(0, 300);
  const timingChanged =
    fields.startTime != null || fields.durationMinutes != null || fields.travelEstimateMinutes !== undefined;
  if (timingChanged && fields.note == null) {
    const next = rewritePlacedNote(item);
    if (next !== item.note) item.note = next;
  }
  return null;
}

function isPinned(item: RoadbookItem): boolean {
  return item.locked || item.title === "去车站";
}

function resolveDay(group: RoadbookItem[], touched: Set<string>): string | null {
  const placed: { start: number; end: number }[] = [];
  const ordered = [...group].sort((a, b) => (parseTime(a.startTime) ?? 0) - (parseTime(b.startTime) ?? 0));
  const locked = ordered.filter((item) => isPinned(item));
  const rest = ordered.filter((item) => !isPinned(item));
  for (const item of locked) {
    const start = parseTime(item.startTime);
    if (start == null) return `「${item.title}」的时间无法解析。`;
    const end = start + item.durationMinutes;
    if (placed.some((block) => start < block.end && end > block.start)) {
      return `锁定项「${item.title}」与其他锁定项时间冲突，不能自动挪动。`;
    }
    placed.push({ start, end });
  }
  for (const item of rest) {
    let start = parseTime(item.startTime);
    if (start == null) return `「${item.title}」的时间无法解析。`;
    let guard = 0;
    while (placed.some((block) => start! < block.end && start! + item.durationMinutes > block.start)) {
      const hit = placed.find((block) => start! < block.end && start! + item.durationMinutes > block.start);
      if (!hit) break;
      start = hit.end;
      guard += 1;
      if (guard > 16) return `「${item.title}」的时间冲突无法修正。`;
    }
    if (start + item.durationMinutes >= 24 * 60 && !mayCrossMidnight(item)) {
      return `「${item.title}」超出当天，无法修正。`;
    }
    const formatted = formatTime(start);
    if (formatted !== item.startTime) {
      item.startTime = formatted;
      const next = rewritePlacedNote(item);
      if (next !== item.note) item.note = next;
      touched.add(item.id);
    }
    placed.push({ start, end: start + item.durationMinutes });
  }
  return null;
}

function resolveTimes(items: RoadbookItem[], touched: Set<string>): string | null {
  const byDay = new Map<number, RoadbookItem[]>();
  for (const item of items) {
    const list = byDay.get(item.dayIndex) ?? [];
    list.push(item);
    byDay.set(item.dayIndex, list);
  }
  for (const group of byDay.values()) {
    const error = resolveDay(group, touched);
    if (error) return error;
  }
  return null;
}

function applyOps(items: RoadbookItem[], ops: PatchOp[], touched: Set<string>): string | null {
  for (const op of ops) {
    if (!op || typeof op !== "object" || typeof op.op !== "string") return "补丁无法解析。";
    if (op.op === "add") {
      const item = normalizeItem(op.item);
      if (typeof item === "string") return item;
      if (items.some((current) => current.id === item.id)) return `「${item.title}」的 id 重复。`;
      items.push(item);
      touched.add(item.id);
      continue;
    }
    if (op.op === "remove") {
      const item = items.find((current) => current.id === op.id);
      if (!item) return "要删除的项不存在。";
      if (item.locked) return `「${item.title}」已锁定，不能改。`;
      const index = items.findIndex((current) => current.id === op.id);
      items.splice(index, 1);
      continue;
    }
    if (op.op === "update") {
      const item = items.find((current) => current.id === op.id);
      if (!item) return "要修改的项不存在。";
      const blocked = lockedUpdateError(item, op.fields);
      if (blocked) return blocked;
      const error = applyFields(item, op.fields);
      if (error) return error;
      touched.add(item.id);
      continue;
    }
    const dayItems = items.filter((item) => item.dayIndex === op.dayIndex);
    if (op.ids.length !== dayItems.length || new Set(op.ids).size !== op.ids.length) {
      return "重排必须包含这一天的每一项，且不能重复。";
    }
    for (const item of dayItems) {
      if (!op.ids.includes(item.id)) return `重排漏了「${item.title}」。`;
    }
    const slots = [...dayItems]
      .sort((a, b) => (parseTime(a.startTime) ?? 0) - (parseTime(b.startTime) ?? 0))
      .map((item) => item.startTime);
    for (let index = 0; index < op.ids.length; index += 1) {
      const item = items.find((current) => current.id === op.ids[index]);
      const slot = slots[index];
      if (!item || !slot) return "重排无法对应时间。";
      if (item.locked && item.startTime !== slot) return `重排会改动已锁定的「${item.title}」。`;
    }
    for (let index = 0; index < op.ids.length; index += 1) {
      const item = items.find((current) => current.id === op.ids[index]);
      const slot = slots[index];
      if (!item || !slot || item.locked) continue;
      if (item.startTime !== slot) {
        item.startTime = slot;
        const next = rewritePlacedNote(item);
        if (next !== item.note) item.note = next;
        touched.add(item.id);
      }
    }
  }
  return null;
}

function readAssumptions(value: Assumption[] | undefined): Assumption[] | string | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > 12) return "假设标签无效。";
  const keys = new Set(["city", "days", "party", "when", "origin", "pace", "budget", "return"]);
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("假设标签无效。");
    if (typeof item.id !== "string" || typeof item.label !== "string" || typeof item.value !== "string") {
      throw new Error("假设标签无效。");
    }
    if (!keys.has(item.key) || typeof item.inferred !== "boolean") throw new Error("假设标签无效。");
    return {
      id: item.id.slice(0, 40),
      key: item.key,
      label: item.label.slice(0, 20),
      value: item.value.slice(0, 80),
      inferred: item.inferred,
      detail: item.detail ? item.detail.slice(0, 120) : undefined,
    };
  });
}

export function projectPatch(
  book: Roadbook,
  request: PatchRequest,
): { ok: true; items: RoadbookItem[] } | { ok: false; error: string } {
  if (!Array.isArray(request.ops) || request.ops.length > MAX_OPS) {
    return { ok: false, error: "补丁太长或无法解析。" };
  }
  const items = book.items.map(cloneItem);
  const touched = new Set<string>();
  const opError = applyOps(items, request.ops, touched);
  if (opError) return { ok: false, error: opError };
  const timeError = resolveTimes(items, touched);
  if (timeError) return { ok: false, error: timeError };
  for (const item of items) item.highlight = touched.has(item.id);
  return { ok: true, items };
}

export function opsFromUnknown(raw: unknown): { ops: PatchOp[] } | { error: string } {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { ops?: unknown }).ops)) {
    return { error: "模型没有返回补丁。" };
  }
  const ops: PatchOp[] = [];
  for (const entry of (raw as { ops: unknown[] }).ops.slice(0, 8)) {
    if (!entry || typeof entry !== "object") return { error: "补丁无法解析。" };
    const record = entry as {
      op?: string;
      id?: string;
      fields?: ItemFields;
      item?: unknown;
      dayIndex?: number;
      ids?: unknown[];
    };
    if (record.op === "remove" && typeof record.id === "string") {
      ops.push({ op: "remove", id: record.id });
      continue;
    }
    if (record.op === "update" && typeof record.id === "string" && record.fields && typeof record.fields === "object") {
      const fields: ItemFields = { ...record.fields };
      delete fields.locked;
      ops.push({ op: "update", id: record.id, fields });
      continue;
    }
    if (record.op === "add") {
      const normalized = normalizeItem(record.item);
      if (typeof normalized === "string") return { error: normalized };
      normalized.locked = false;
      ops.push({ op: "add", item: normalized });
      continue;
    }
    if (record.op === "reorder" && typeof record.dayIndex === "number" && Array.isArray(record.ids)) {
      const ids = record.ids.filter((id): id is string => typeof id === "string");
      ops.push({ op: "reorder", dayIndex: record.dayIndex, ids });
      continue;
    }
    return { error: "有一条补丁无法解析。" };
  }
  return { ops };
}

export function endsAfterDay(item: RoadbookItem, limit = DAY_END_MINUTES): boolean {
  const end = endOf(item);
  return end != null && end > limit;
}

function markAssumptions(previous: Assumption[], next: Assumption[] | undefined): Assumption[] {
  const source = next ?? previous;
  const prior = new Map(previous.map((item) => [item.id, item.value]));
  return source.map((item) => ({
    ...item,
    changed: next != null && item.value !== prior.get(item.id),
  }));
}

function droppedBy(book: Roadbook, ops: PatchOp[]): { id: string; title: string }[] {
  const dropped: { id: string; title: string }[] = [];
  for (const op of ops) {
    if (op.op !== "remove") continue;
    const item = book.items.find((current) => current.id === op.id);
    if (item) dropped.push({ id: item.id, title: item.title });
  }
  return dropped;
}

function endOf(item: RoadbookItem): number | null {
  const start = parseTime(item.startTime);
  if (start == null) return null;
  return start + item.durationMinutes;
}

export function applyPatch(book: Roadbook, request: PatchRequest, now = new Date()): PatchResult {
  const patchId = request.id?.trim() || `p_${now.getTime().toString(36)}`;
  if (book.patchHistory.some((patch) => patch.id === patchId)) {
    return { ok: true, book };
  }
  let assumptions: Assumption[] | undefined;
  try {
    const read = readAssumptions(request.assumptions);
    if (typeof read === "string") return { ok: false, error: read, book };
    assumptions = read;
  } catch (error) {
    const message = error instanceof Error ? error.message : "假设标签无效。";
    return { ok: false, error: message, book };
  }
  const projected = projectPatch(book, request);
  if (!projected.ok) return { ok: false, error: projected.error, book };

  const verifyChecklist: VerifyItem[] = book.verifyChecklist.map((item) => ({ ...item }));
  for (const text of request.verifyAdds ?? []) {
    const clean = text.trim().slice(0, 200);
    if (!clean || verifyChecklist.some((item) => item.text === clean)) continue;
    verifyChecklist.push({ id: `v_${patchId}_${verifyChecklist.length}`, text: clean });
  }

  const applied: AppliedPatch = {
    id: patchId,
    at: request.at ?? now.toISOString(),
    label: request.label.slice(0, 80) || "补丁",
    kind: request.kind,
    ops: request.ops.map(cloneOp),
    dropped: droppedBy(book, request.ops),
  };
  const undo = {
    patchId,
    items: book.items.map(cloneItem),
    assumptions: book.assumptions.map((item) => ({ ...item })),
    weather: book.weather.map((item) => ({ ...item })),
    verifyChecklist: book.verifyChecklist.map((item) => ({ ...item })),
    title: book.title,
    city: book.city,
    startDate: book.startDate,
    question: book.question ? { ...book.question } : null,
    statusLine: book.statusLine,
  };
  const next: Roadbook = {
    ...cloneBook(book),
    title: request.title?.trim().slice(0, 80) || book.title,
    city: request.city?.trim().slice(0, 40) || book.city,
    startDate: request.startDate?.trim() || book.startDate,
    assumptions: markAssumptions(book.assumptions, assumptions),
    items: projected.items,
    verifyChecklist,
    question: request.setQuestion === undefined ? book.question : request.setQuestion,
    statusLine: (request.statusNote ?? `已应用：${request.label}`).slice(0, 180),
    updatedAt: now.toISOString(),
    patchHistory: [...book.patchHistory, applied].slice(-30),
    undo,
  };
  return { ok: true, book: next };
}

export function undoLast(book: Roadbook, now = new Date()): PatchResult {
  if (!book.undo) return { ok: false, error: "没有可撤销的补丁。", book };
  const snapshot = book.undo;
  const next: Roadbook = {
    ...cloneBook(book),
    items: snapshot.items.map(cloneItem),
    assumptions: snapshot.assumptions.map((item) => ({ ...item })),
    weather: snapshot.weather.map((item) => ({ ...item })),
    verifyChecklist: snapshot.verifyChecklist.map((item) => ({ ...item })),
    title: snapshot.title,
    city: snapshot.city,
    startDate: snapshot.startDate,
    question: snapshot.question ? { ...snapshot.question } : null,
    statusLine: "已撤销上一次改动。",
    patchHistory: book.patchHistory.filter((patch) => patch.id !== snapshot.patchId),
    undo: null,
    updatedAt: now.toISOString(),
  };
  for (const item of next.items) item.highlight = false;
  next.assumptions = next.assumptions.map((item) => ({ ...item, changed: false }));
  return { ok: true, book: next };
}

export function replaceWeather(book: Roadbook, weather: Roadbook["weather"], now = new Date()): Roadbook {
  return {
    ...cloneBook(book),
    weather: weather.map((item) => ({ ...item })),
    updatedAt: now.toISOString(),
  };
}
