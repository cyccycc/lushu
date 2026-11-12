export const ITEM_TYPES = ["交通", "景点", "餐", "休息", "自由", "办事"] as const;
export const ITEM_STATUSES = ["待做", "已完成", "已跳过"] as const;
export const SOURCE_KINDS = ["实测", "检索", "推断"] as const;
export const PRIORITIES = ["必去", "想去", "可砍"] as const;

export type ItemType = (typeof ITEM_TYPES)[number];
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type Priority = (typeof PRIORITIES)[number];
export type EstimateSource = "实测" | "检索" | "推断";

export type ItemSource = {
  kind: SourceKind;
  url?: string;
  fetchedAt?: string;
  note?: string;
};

export type RoadbookItem = {
  id: string;
  dayIndex: number;
  startTime: string;
  durationMinutes: number;
  title: string;
  place: string;
  lat: number | null;
  lng: number | null;
  type: ItemType;
  status: ItemStatus;
  source: ItemSource;
  travelEstimateMinutes: number | null;
  estimateSource?: EstimateSource;
  locked: boolean;
  priority: Priority;
  indoor: boolean;
  highlight: boolean;
  note?: string;
};

export type AssumptionKey = "city" | "days" | "party" | "when" | "origin" | "pace" | "budget" | "return";

export type Assumption = {
  id: string;
  key: AssumptionKey;
  label: string;
  value: string;
  inferred: boolean;
  detail?: string;
  /** True only on the assumption tags changed by the latest patch. */
  changed?: boolean;
};

export type WeatherSnap = {
  city: string;
  query: string;
  date: string | null;
  condition: string;
  tempMinC: number | null;
  tempMaxC: number | null;
  precipProbability: number | null;
  available: boolean;
  note: string;
  fetchedAt: string;
  sourceUrl?: string | null;
};

export type VerifyItem = {
  id: string;
  text: string;
  /** Itinerary item this row is about, when there is exactly one. */
  itemId?: string;
  /**
   * When the row was checked. Absent means unchecked.
   * A check is not a patch and is not stored on the undo stack.
   */
  checkedAt?: string;
};

export type RoadbookQuestion = {
  id: string;
  prompt: string;
};

export type PatchKind = "draft" | "user" | "late" | "rain" | "tired" | "assumption" | "model" | "style";

export const ROADBOOK_STYLES = ["更轻松", "更省钱", "雨天版", "少走路"] as const;
export type RoadbookStyle = (typeof ROADBOOK_STYLES)[number];

/**
 * Shown before replacing a style, or the main plan, after a hand edit.
 * Locked items stay as they are; the prompt says so.
 */
export const STYLE_CONFIRM = "切换风格之后你改过的内容也会撤掉。锁定的项会保留。";

export type MainPlanSnapshot = {
  id: string;
  items: RoadbookItem[];
  assumptions: Assumption[];
  weather: WeatherSnap[];
  verifyChecklist: VerifyItem[];
  title: string;
  city: string;
  startDate: string;
  question: RoadbookQuestion | null;
  statusLine: string;
};

export type ItemFields = Partial<
  Pick<
    RoadbookItem,
    | "dayIndex"
    | "startTime"
    | "durationMinutes"
    | "title"
    | "place"
    | "lat"
    | "lng"
    | "type"
    | "status"
    | "source"
    | "travelEstimateMinutes"
    | "estimateSource"
    | "locked"
    | "priority"
    | "indoor"
    | "note"
  >
>;

export type PatchOp =
  | { op: "add"; item: RoadbookItem }
  | { op: "update"; id: string; fields: ItemFields }
  | { op: "remove"; id: string }
  | { op: "reorder"; dayIndex: number; ids: string[] };

export type AppliedPatch = {
  id: string;
  at: string;
  label: string;
  kind: PatchKind;
  ops: PatchOp[];
  /** Titles removed by this patch, so the UI can say what disappeared. */
  dropped?: { id: string; title: string }[];
};

/** How many undo steps a book keeps. Older steps drop off the front. */
export const UNDO_STACK_LIMIT = 20;

/** Placeholder owner until invite-code spaces exist. Not an access check. */
export const DEFAULT_OWNER_ID = "me";

export type UndoSnapshot = {
  patchId: string;
  items: RoadbookItem[];
  assumptions: Assumption[];
  weather: WeatherSnap[];
  /**
   * Checklist rows that existed before the patch (id, text, and itemId).
   * Check marks are not a patch and are not stored here; undo restores which
   * rows exist and leaves a surviving row's check mark alone.
   */
  verifyChecklist: VerifyItem[];
  title: string;
  city: string;
  startDate: string;
  question: RoadbookQuestion | null;
  statusLine: string;
  /** Style in effect before this patch. Missing on older frames means none. */
  style?: RoadbookStyle | null;
  /** Main-plan snapshot this frame belonged to. Missing means none. */
  mainPlanId?: string | null;
  /** Hand edits since the style in this frame. */
  styleDirty?: boolean;
};

export type Roadbook = {
  id: string;
  createdAt: string;
  updatedAt: string;
  brief: string;
  title: string;
  city: string;
  startDate: string;
  assumptions: Assumption[];
  items: RoadbookItem[];
  weather: WeatherSnap[];
  verifyChecklist: VerifyItem[];
  patchHistory: AppliedPatch[];
  /**
   * Undo stack, oldest first. Empty means nothing to undo.
   * Files written before this stack may still hold one snapshot or null;
   * `readUndoStack` accepts those and the next save writes the array.
   */
  undo: UndoSnapshot[];
  question: RoadbookQuestion | null;
  statusLine: string;
  /**
   * Reserved for a later per-person space. New books and books read back
   * without the field use "me". P1 does not filter or authorize with it.
   */
  ownerId?: string;
  /** Active style. Null means the book is showing its main plan. */
  style?: RoadbookStyle | null;
  /** Snapshot the active style was built from. Not part of the undo stack. */
  mainPlanId?: string | null;
  /** Main plans still referenced by the current book or an undo frame. */
  mainPlans?: MainPlanSnapshot[];
  /** True after a hand edit while a style is active. */
  styleDirty?: boolean;
  /** Validated model extract, kept for debugging. Raw model text is never stored. */
  extract?: {
    kind: "旅游" | "办事" | "混合";
    origin: string | null;
    destination: { city: string | null; area: string | null };
    startDate: string | null;
    endDate: string | null;
    party: number | null;
    outbound: {
      date: string | null;
      time: string | null;
      mode: "高铁" | "飞机" | "自驾" | "其他" | null;
      from: string | null;
      to: string | null;
    } | null;
    inbound: {
      date: string | null;
      time: string | null;
      mode: "高铁" | "飞机" | "自驾" | "其他" | null;
      from: string | null;
      to: string | null;
    } | null;
    fixed: {
      date: string | null;
      time: string | null;
      endTime: string | null;
      title: string;
      place: string | null;
      type: ItemType;
    }[];
    lodging: { booked: boolean; area: string | null } | null;
    interests: string[];
    pace: string | null;
    budget: string | null;
    missing: string[];
  } | null;
};

export type PatchRequest = {
  id?: string;
  at?: string;
  label: string;
  kind: PatchKind;
  ops: PatchOp[];
  assumptions?: Assumption[];
  verifyAdds?: (string | { text: string; itemId?: string })[];
  setQuestion?: RoadbookQuestion | null;
  title?: string;
  city?: string;
  startDate?: string;
  statusNote?: string;
};

export type PatchResult =
  | { ok: true; book: Roadbook }
  | { ok: false; error: string; book: Roadbook };

export type Plan = {
  request: PatchRequest | null;
  note: string;
};
