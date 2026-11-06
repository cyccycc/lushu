export const ITEM_TYPES = ["交通", "景点", "餐", "休息", "自由"] as const;
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

export type AssumptionKey = "city" | "days" | "party" | "when" | "origin" | "pace" | "budget";

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
};

export type RoadbookQuestion = {
  id: string;
  prompt: string;
};

export type PatchKind = "draft" | "user" | "late" | "rain" | "tired" | "assumption" | "model";

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

export type UndoSnapshot = {
  patchId: string;
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
  undo: UndoSnapshot | null;
  question: RoadbookQuestion | null;
  statusLine: string;
};

export type PatchRequest = {
  id?: string;
  at?: string;
  label: string;
  kind: PatchKind;
  ops: PatchOp[];
  assumptions?: Assumption[];
  verifyAdds?: string[];
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
