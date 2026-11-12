import { relabelConfirmedSource } from "./honesty";
import { DAY_END_MINUTES, formatTime, noteForPlacedClock, parseTime } from "./time";
import {
  DEFAULT_OWNER_ID,
  ITEM_STATUSES,
  ITEM_TYPES,
  PRIORITIES,
  ROADBOOK_STYLES,
  SOURCE_KINDS,
  type AppliedPatch,
  type Assumption,
  type ItemFields,
  type ItemSource,
  type MainPlanSnapshot,
  type PatchOp,
  type PatchRequest,
  type PatchResult,
  type Roadbook,
  type RoadbookItem,
  type RoadbookStyle,
  type SourceKind,
  type UndoSnapshot,
  type VerifyItem,
  UNDO_STACK_LIMIT,
} from "./types";

const MAX_OPS = 160;

function cloneItem(item: RoadbookItem): RoadbookItem {
  return {
    ...item,
    source: { ...item.source },
    highlight: false,
  };
}

function checklistIdentity(item: VerifyItem): VerifyItem {
  const row: VerifyItem = { id: item.id, text: item.text };
  if (item.itemId) row.itemId = item.itemId;
  return row;
}

function relabelItem(item: RoadbookItem): RoadbookItem {
  const source = relabelConfirmedSource(item.source);
  if (source === item.source) return item;
  return { ...item, source };
}

function relabelOp(op: PatchOp): PatchOp {
  if (op.op === "add") {
    const item = relabelItem(op.item);
    return item === op.item ? op : { op: "add", item };
  }
  if (op.op === "update" && op.fields.source) {
    const source = relabelConfirmedSource(op.fields.source);
    if (source === op.fields.source) return op;
    return { ...op, fields: { ...op.fields, source } };
  }
  return op;
}

function liveChecklistRow(item: VerifyItem): VerifyItem {
  const row: VerifyItem = { id: item.id, text: item.text };
  if (typeof item.itemId === "string" && item.itemId.trim()) row.itemId = item.itemId.trim().slice(0, 40);
  if (typeof item.checkedAt === "string" && item.checkedAt.trim()) row.checkedAt = item.checkedAt.trim().slice(0, 40);
  return row;
}

function sameChecklistRow(left: VerifyItem, right: VerifyItem): boolean {
  return left.id === right.id && left.text === right.text && left.itemId === right.itemId && left.checkedAt === right.checkedAt;
}

function readStyle(value: unknown): RoadbookStyle | null {
  return typeof value === "string" && (ROADBOOK_STYLES as readonly string[]).includes(value) ? (value as RoadbookStyle) : null;
}

function isMainPlan(value: unknown): value is MainPlanSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as { id?: unknown; items?: unknown };
  return typeof raw.id === "string" && Array.isArray(raw.items);
}

function readMainPlans(value: unknown): MainPlanSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isMainPlan).map((plan) => ({
    ...plan,
    items: plan.items.map(relabelItem),
    assumptions: Array.isArray(plan.assumptions) ? plan.assumptions.map((item) => ({ ...item })) : [],
    weather: Array.isArray(plan.weather) ? plan.weather.map((item) => ({ ...item })) : [],
    verifyChecklist: (Array.isArray(plan.verifyChecklist) ? plan.verifyChecklist : []).map(checklistIdentity),
    question: plan.question ? { ...plan.question } : null,
    statusLine: plan.statusLine ?? "",
  }));
}

/** Drop main plans that neither the current book nor an undo frame still names. */
export function retainMainPlans<T extends Roadbook>(book: T): T {
  const plans = book.mainPlans ?? [];
  const referenced = new Set<string>();
  if (book.mainPlanId) referenced.add(book.mainPlanId);
  for (const frame of book.undo ?? []) {
    if (frame.mainPlanId) referenced.add(frame.mainPlanId);
  }
  const mainPlans = plans.filter((plan) => referenced.has(plan.id));
  const dangling = Boolean(book.mainPlanId) && !mainPlans.some((plan) => plan.id === book.mainPlanId);
  const same =
    !dangling &&
    mainPlans.length === plans.length &&
    mainPlans.every((plan, index) => plan === plans[index]);
  if (same) return book;
  return {
    ...book,
    mainPlans,
    mainPlanId: dangling ? null : book.mainPlanId ?? null,
    style: dangling ? null : book.style ?? null,
    styleDirty: dangling ? false : book.styleDirty === true,
  };
}

function isUndoSnapshot(value: unknown): value is UndoSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as { patchId?: unknown; items?: unknown };
  return typeof raw.patchId === "string" && Array.isArray(raw.items);
}

/** One snapshot, a stack, or the older null. Newest entry is last. */
export function readUndoStack(undo: unknown): UndoSnapshot[] {
  if (Array.isArray(undo)) return undo.filter(isUndoSnapshot).slice(-UNDO_STACK_LIMIT);
  if (isUndoSnapshot(undo)) return [undo];
  return [];
}

function snapshotChanged(snapshot: UndoSnapshot, items: RoadbookItem[], verifyChecklist: VerifyItem[]): boolean {
  if (items.length !== snapshot.items.length || items.some((item, index) => item !== snapshot.items[index])) return true;
  const previous = Array.isArray(snapshot.verifyChecklist) ? snapshot.verifyChecklist : [];
  if (verifyChecklist.length !== previous.length) return true;
  return verifyChecklist.some((row, index) => {
    const prev = previous[index];
    if (!prev || !sameChecklistRow(checklistIdentity(prev), row)) return true;
    return Object.prototype.hasOwnProperty.call(prev, "checkedAt");
  });
}

/**
 * Fill ownerId, map old 「来自你的原话 / 你改的时间」+ 推断 labels onto 实测,
 * and accept a legacy single undo snapshot. Check marks stay on the live list.
 * The next save writes this shape; there is no separate migration script.
 */
export function normalizeRoadbook<T extends Roadbook>(book: T): T {
  const ownerId = typeof book.ownerId === "string" && book.ownerId.trim() ? book.ownerId.trim() : DEFAULT_OWNER_ID;
  const items = book.items.map(relabelItem);
  const undo = readUndoStack(book.undo).map((snapshot) => {
    const nextItems = snapshot.items.map(relabelItem);
    const verifyChecklist = (Array.isArray(snapshot.verifyChecklist) ? snapshot.verifyChecklist : []).map(checklistIdentity);
    const style = readStyle(snapshot.style);
    const mainPlanId = typeof snapshot.mainPlanId === "string" ? snapshot.mainPlanId : null;
    const styleDirty = snapshot.styleDirty === true;
    const styleSame = snapshot.style === style && (snapshot.mainPlanId ?? null) === mainPlanId && snapshot.styleDirty === styleDirty;
    if (!snapshotChanged(snapshot, nextItems, verifyChecklist) && styleSame) return snapshot;
    return { ...snapshot, items: nextItems, verifyChecklist, style, mainPlanId, styleDirty };
  });
  const patchHistory = book.patchHistory.map((patch) => {
    const ops = patch.ops.map(relabelOp);
    if (ops.every((op, index) => op === patch.ops[index])) return patch;
    return { ...patch, ops };
  });
  const verifyChecklist = (Array.isArray(book.verifyChecklist) ? book.verifyChecklist : []).map(liveChecklistRow);
  const itemsSame = items.every((item, index) => item === book.items[index]);
  const undoSame = Array.isArray(book.undo) && book.undo.length === undo.length && undo.every((snapshot, index) => snapshot === book.undo[index]);
  const historySame = patchHistory.every((patch, index) => patch === book.patchHistory[index]);
  const checksSame =
    Array.isArray(book.verifyChecklist) &&
    verifyChecklist.length === book.verifyChecklist.length &&
    verifyChecklist.every((row, index) => sameChecklistRow(row, book.verifyChecklist[index]!));
  const style = readStyle(book.style);
  const mainPlanId = typeof book.mainPlanId === "string" ? book.mainPlanId : null;
  const styleDirty = book.styleDirty === true;
  const mainPlans = readMainPlans(book.mainPlans);
  const styleSame = book.style === style && (book.mainPlanId ?? null) === mainPlanId && book.styleDirty === styleDirty;
  const plansSame =
    Array.isArray(book.mainPlans) &&
    book.mainPlans.length === mainPlans.length &&
    mainPlans.every((plan, index) => plan === book.mainPlans?.[index]);
  if (book.ownerId === ownerId && itemsSame && undoSame && historySame && checksSame && styleSame && plansSame) {
    return retainMainPlans(book);
  }
  return retainMainPlans({ ...book, ownerId, items, undo, patchHistory, verifyChecklist, style, mainPlanId, styleDirty, mainPlans });
}

export function normalizeRoadbookUndo<T extends Roadbook>(book: T): T {
  return normalizeRoadbook(book);
}

function cloneSnapshot(snapshot: UndoSnapshot): UndoSnapshot {
  const assumptions = Array.isArray(snapshot.assumptions) ? snapshot.assumptions : [];
  const weather = Array.isArray(snapshot.weather) ? snapshot.weather : [];
  const verifyChecklist = Array.isArray(snapshot.verifyChecklist) ? snapshot.verifyChecklist : [];
  return {
    patchId: snapshot.patchId,
    items: snapshot.items.map(cloneItem),
    assumptions: assumptions.map((item) => ({ ...item, changed: false })),
    weather: weather.map((item) => ({ ...item })),
    verifyChecklist: verifyChecklist.map(checklistIdentity),
    title: snapshot.title,
    city: snapshot.city,
    startDate: snapshot.startDate,
    question: snapshot.question ? { ...snapshot.question } : null,
    statusLine: snapshot.statusLine ?? "",
    style: readStyle(snapshot.style),
    mainPlanId: typeof snapshot.mainPlanId === "string" ? snapshot.mainPlanId : null,
    styleDirty: snapshot.styleDirty === true,
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
    undo: readUndoStack(book.undo).map(cloneSnapshot),
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

const ITEM_FIELD_KEYS = [
  "dayIndex",
  "startTime",
  "durationMinutes",
  "title",
  "place",
  "lat",
  "lng",
  "type",
  "status",
  "source",
  "travelEstimateMinutes",
  "estimateSource",
  "locked",
  "priority",
  "indoor",
  "note",
] as const satisfies readonly (keyof ItemFields)[];

const itemFieldKeysCovered: Exclude<keyof ItemFields, (typeof ITEM_FIELD_KEYS)[number]> extends never ? true : never = true;
void itemFieldKeysCovered;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Item fields only. `locked` is dropped so a model patch cannot lock or unlock. */
function pickItemFields(source: Record<string, unknown>): ItemFields {
  const fields: Record<string, unknown> = {};
  for (const key of ITEM_FIELD_KEYS) {
    if (key === "locked" || !Object.prototype.hasOwnProperty.call(source, key)) continue;
    fields[key] = source[key];
  }
  return fields as ItemFields;
}

function hasItemField(source: Record<string, unknown>): boolean {
  return ITEM_FIELD_KEYS.some((key) => Object.prototype.hasOwnProperty.call(source, key));
}

export function opsFromUnknown(raw: unknown): { ops: PatchOp[] } | { error: string } {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { ops?: unknown }).ops)) {
    return { error: "模型没有返回补丁。" };
  }
  const ops: PatchOp[] = [];
  for (const entry of (raw as { ops: unknown[] }).ops.slice(0, 8)) {
    if (!isPlainObject(entry)) return { error: "补丁无法解析。" };
    const record = entry;
    if (record.op === "remove" && typeof record.id === "string") {
      ops.push({ op: "remove", id: record.id });
      continue;
    }
    if (record.op === "update" && typeof record.id === "string") {
      // Wrapped {op,id,fields} stays valid. A flat update puts those same fields beside op and id.
      const source = isPlainObject(record.fields) ? record.fields : hasItemField(record) ? record : null;
      if (source) {
        const fields = pickItemFields(source);
        // `locked` is not a model field. An update that only carried it is not a change.
        if (Object.keys(fields).length > 0) ops.push({ op: "update", id: record.id, fields });
        continue;
      }
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

const MODEL_CLAIM = /来自你的原话|你改的时间/g;

/** Model copy must not wear a user-stated label. Real user edits keep these phrases. */
export function stripModelClaim(text: string): string {
  if (!text.includes("来自你的原话") && !text.includes("你改的时间")) return text;
  const next = text
    .replace(MODEL_CLAIM, "")
    .replace(/[·・]{2,}/g, "·")
    .replace(/^[·・\s。，、；：]+|[·・\s]+$/g, "")
    .replace(/。{2,}/g, "。")
    .trim();
  return next === "实测" ? "" : next;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** 检索 survives only with both a URL and a fetch time. Every other kind becomes 推断. */
export function sanitizeModelSource(source: ItemSource): ItemSource {
  const url = nonempty(source.url);
  const fetchedAt = nonempty(source.fetchedAt);
  const kind: SourceKind = source.kind === "检索" && url && fetchedAt ? "检索" : "推断";
  const note = typeof source.note === "string" ? stripModelClaim(source.note) : "";
  const next: ItemSource = { kind };
  if (url) next.url = url;
  if (fetchedAt) next.fetchedAt = fetchedAt;
  if (note) next.note = note;
  return next;
}

function sanitizeModelFields(fields: ItemFields): ItemFields {
  const next: ItemFields = { ...fields };
  delete next.locked;
  if (next.source) next.source = sanitizeModelSource(next.source);
  if (typeof next.note === "string") next.note = stripModelClaim(next.note);
  return next;
}

function sanitizeModelItem(item: RoadbookItem): RoadbookItem {
  const note = typeof item.note === "string" ? stripModelClaim(item.note) : "";
  return {
    ...item,
    locked: false,
    source: sanitizeModelSource(item.source),
    note: note || undefined,
  };
}

function hasPatchFields(fields: ItemFields): boolean {
  return Object.values(fields).some((value) => value !== undefined);
}

/** Model ops only. Drops a lock-only update and refuses a fake 实测 / 来自你的原话 label. */
export function sanitizeModelOps(ops: PatchOp[]): PatchOp[] {
  const next: PatchOp[] = [];
  for (const op of ops) {
    if (op.op === "remove" || op.op === "reorder") {
      next.push(op);
      continue;
    }
    if (op.op === "add") {
      next.push({ op: "add", item: sanitizeModelItem(op.item) });
      continue;
    }
    const fields = sanitizeModelFields(op.fields);
    if (!hasPatchFields(fields)) continue;
    next.push({ op: "update", id: op.id, fields });
  }
  return next;
}

function modelPatchIsEmpty(request: PatchRequest, ops: PatchOp[]): boolean {
  if (request.kind !== "model" || ops.length > 0) return false;
  if (request.assumptions != null || request.title != null || request.city != null || request.startDate != null) {
    return false;
  }
  if (request.verifyAdds != null && request.verifyAdds.length > 0) return false;
  return request.setQuestion === undefined;
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

/** Fields a locked item is not allowed to change. Status and the lock itself may. */
function protectedFieldsDiffer(current: RoadbookItem, restored: RoadbookItem): boolean {
  return (
    current.dayIndex !== restored.dayIndex ||
    current.startTime !== restored.startTime ||
    current.durationMinutes !== restored.durationMinutes ||
    current.title !== restored.title ||
    current.place !== restored.place ||
    current.lat !== restored.lat ||
    current.lng !== restored.lng ||
    current.type !== restored.type ||
    current.travelEstimateMinutes !== restored.travelEstimateMinutes ||
    current.estimateSource !== restored.estimateSource ||
    current.priority !== restored.priority ||
    current.indoor !== restored.indoor ||
    current.note !== restored.note ||
    current.source.kind !== restored.source.kind ||
    current.source.url !== restored.source.url ||
    current.source.fetchedAt !== restored.source.fetchedAt ||
    current.source.note !== restored.source.note
  );
}

function sameItemContent(current: RoadbookItem, restored: RoadbookItem): boolean {
  return !protectedFieldsDiffer(current, restored) && current.status === restored.status && current.locked === restored.locked;
}

/** This undo step itself changed the lock or the priority, so the whole patch may revert. */
function patchRevertsOwnLock(patch: { ops: PatchOp[] } | undefined, itemId: string): boolean {
  if (!patch) return false;
  return patch.ops.some((op) => {
    if (op.op !== "update" || op.id !== itemId) return false;
    return Object.prototype.hasOwnProperty.call(op.fields, "locked") || Object.prototype.hasOwnProperty.call(op.fields, "priority");
  });
}

function undoLockError(book: Roadbook, restored: RoadbookItem[], patchId: string): string | null {
  const restoredById = new Map(restored.map((item) => [item.id, item]));
  const patch = book.patchHistory.find((entry) => entry.id === patchId);
  const added = new Set((patch?.ops ?? []).flatMap((op) => (op.op === "add" ? [op.item.id] : [])));
  for (const item of book.items) {
    if (!item.locked) continue;
    if (patchRevertsOwnLock(patch, item.id)) continue;
    const prev = restoredById.get(item.id);
    if (!prev) {
      if (added.has(item.id)) continue;
      return `「${item.title}」已锁定，不能改。`;
    }
    if (protectedFieldsDiffer(item, prev)) return `「${item.title}」已锁定，不能改。`;
  }
  return null;
}

function markUndoneAssumptions(previous: Assumption[], current: Assumption[]): Assumption[] {
  const currentValues = new Map(current.map((item) => [item.id, item.value]));
  return previous.map((item) => ({
    ...item,
    changed: currentValues.get(item.id) !== item.value,
  }));
}

function restoreChecklist(previous: VerifyItem[], current: VerifyItem[]): VerifyItem[] {
  const currentById = new Map(current.map((item) => [item.id, item]));
  return previous.map((item) => {
    const row = checklistIdentity(item);
    const live = currentById.get(item.id);
    if (!live || !Object.prototype.hasOwnProperty.call(live, "checkedAt")) return row;
    return { ...row, checkedAt: live.checkedAt };
  });
}

function readVerifyAdd(value: string | { text: string; itemId?: string }): { text: string; itemId?: string } | null {
  if (typeof value === "string") {
    const text = value.trim().slice(0, 200);
    return text ? { text } : null;
  }
  if (!value || typeof value.text !== "string") return null;
  const text = value.text.trim().slice(0, 200);
  if (!text) return null;
  const itemId = typeof value.itemId === "string" && value.itemId.trim() ? value.itemId.trim().slice(0, 40) : undefined;
  return itemId ? { text, itemId } : { text };
}

/** Record or clear one checklist mark. Does not push an undo snapshot or a patch. */
export function setChecklistChecked(book: Roadbook, rowId: string, checked: boolean, now = new Date()): PatchResult {
  const current = normalizeRoadbook(book);
  if (!current.verifyChecklist.some((item) => item.id === rowId)) {
    return { ok: false, error: "没有这条核实项。", book: current };
  }
  const verifyChecklist = current.verifyChecklist.map((item) => {
    if (item.id !== rowId) return item;
    if (!checked) return checklistIdentity(item);
    return { ...checklistIdentity(item), checkedAt: now.toISOString() };
  });
  return {
    ok: true,
    book: {
      ...current,
      verifyChecklist,
      updatedAt: now.toISOString(),
    },
  };
}

export function applyPatch(book: Roadbook, request: PatchRequest, now = new Date()): PatchResult {
  const currentBook = normalizeRoadbook(book);
  const patchId = request.id?.trim() || `p_${now.getTime().toString(36)}`;
  if (currentBook.patchHistory.some((patch) => patch.id === patchId)) {
    return { ok: true, book: currentBook };
  }
  const ops = request.kind === "model" ? sanitizeModelOps(request.ops) : request.ops;
  if (modelPatchIsEmpty(request, ops)) return { ok: true, book: currentBook };
  const effective: PatchRequest = { ...request, ops };
  let assumptions: Assumption[] | undefined;
  try {
    const read = readAssumptions(request.assumptions);
    if (typeof read === "string") return { ok: false, error: read, book: currentBook };
    assumptions = read;
  } catch (error) {
    const message = error instanceof Error ? error.message : "假设标签无效。";
    return { ok: false, error: message, book: currentBook };
  }
  const projected = projectPatch(currentBook, effective);
  if (!projected.ok) return { ok: false, error: projected.error, book: currentBook };

  const verifyChecklist: VerifyItem[] = currentBook.verifyChecklist.map((item) => ({ ...item }));
  for (const add of request.verifyAdds ?? []) {
    const parsed = readVerifyAdd(add);
    if (!parsed || verifyChecklist.some((item) => item.text === parsed.text)) continue;
    const row: VerifyItem = { id: `v_${patchId}_${verifyChecklist.length}`, text: parsed.text };
    if (parsed.itemId) row.itemId = parsed.itemId;
    verifyChecklist.push(row);
  }

  const applied: AppliedPatch = {
    id: patchId,
    at: request.at ?? now.toISOString(),
    label: request.label.slice(0, 80) || "补丁",
    kind: request.kind,
    ops: effective.ops.map(cloneOp),
    dropped: droppedBy(currentBook, effective.ops),
  };
  const undo = [
    ...readUndoStack(currentBook.undo).map(cloneSnapshot),
    cloneSnapshot({
      patchId,
      items: currentBook.items,
      assumptions: currentBook.assumptions,
      weather: currentBook.weather,
      verifyChecklist: currentBook.verifyChecklist,
      title: currentBook.title,
      city: currentBook.city,
      startDate: currentBook.startDate,
      question: currentBook.question,
      statusLine: currentBook.statusLine,
      style: readStyle(currentBook.style),
      mainPlanId: currentBook.mainPlanId ?? null,
      styleDirty: currentBook.styleDirty === true,
    }),
  ].slice(-UNDO_STACK_LIMIT);
  const styleDirty = currentBook.style && request.kind !== "style" ? true : currentBook.styleDirty === true;
  const next: Roadbook = {
    ...cloneBook(currentBook),
    title: request.title?.trim().slice(0, 80) || currentBook.title,
    city: request.city?.trim().slice(0, 40) || currentBook.city,
    startDate: request.startDate?.trim() || currentBook.startDate,
    assumptions: markAssumptions(currentBook.assumptions, assumptions),
    items: projected.items,
    verifyChecklist,
    question: request.setQuestion === undefined ? currentBook.question : request.setQuestion,
    statusLine: (request.statusNote ?? `已应用：${request.label}`).slice(0, 180),
    updatedAt: now.toISOString(),
    patchHistory: [...currentBook.patchHistory, applied].slice(-30),
    undo,
    styleDirty,
  };
  return { ok: true, book: retainMainPlans(next) };
}

export function undoLast(book: Roadbook, now = new Date()): PatchResult {
  const currentBook = normalizeRoadbook(book);
  const stack = readUndoStack(currentBook.undo).map(cloneSnapshot);
  const snapshot = stack[stack.length - 1];
  if (!snapshot) return { ok: false, error: "没有可撤销的补丁。", book: currentBook };
  const items = snapshot.items.map(cloneItem);
  const lockError = undoLockError(currentBook, items, snapshot.patchId);
  if (lockError) return { ok: false, error: lockError, book: currentBook };
  const next: Roadbook = {
    ...cloneBook(currentBook),
    items,
    assumptions: markUndoneAssumptions(snapshot.assumptions, currentBook.assumptions),
    weather: snapshot.weather.map((item) => ({ ...item })),
    verifyChecklist: restoreChecklist(snapshot.verifyChecklist, currentBook.verifyChecklist),
    title: snapshot.title,
    city: snapshot.city,
    startDate: snapshot.startDate,
    question: snapshot.question ? { ...snapshot.question } : null,
    statusLine: "已撤销上一次改动。",
    patchHistory: currentBook.patchHistory.filter((patch) => patch.id !== snapshot.patchId),
    undo: stack.slice(0, -1),
    updatedAt: now.toISOString(),
    style: readStyle(snapshot.style),
    mainPlanId: snapshot.mainPlanId ?? null,
    styleDirty: snapshot.styleDirty === true,
  };
  for (const item of next.items) {
    const previous = currentBook.items.find((current) => current.id === item.id);
    item.highlight = !previous || !sameItemContent(previous, item);
  }
  return { ok: true, book: retainMainPlans(next) };
}

export function replaceWeather(book: Roadbook, weather: Roadbook["weather"], now = new Date()): Roadbook {
  return {
    ...cloneBook(book),
    weather: weather.map((item) => ({ ...item })),
    updatedAt: now.toISOString(),
  };
}
