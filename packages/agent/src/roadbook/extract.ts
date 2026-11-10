import { chatComplete, type LlmEnv } from "@lushu/llm";
import { isVaguePlaceName, matchTravelRoute, resolvePlaceToken } from "@lushu/tools/place";
import { extractJson } from "../json";
import { foldUnclockedVisits } from "./draft";
import { addDays, daysBetween, shanghaiDate, shanghaiWeekday } from "./time";
import type { ItemType } from "./types";

export type Leg = {
  date: string | null;
  time: string | null;
  mode: "高铁" | "飞机" | "自驾" | "其他" | null;
  from: string | null;
  to: string | null;
};

export type TripFixed = {
  date: string | null;
  time: string | null;
  endTime: string | null;
  title: string;
  place: string | null;
  type: ItemType;
};

export type TripExtract = {
  kind: "旅游" | "办事" | "混合";
  origin: string | null;
  destination: { city: string | null; area: string | null };
  startDate: string | null;
  endDate: string | null;
  party: number | null;
  outbound: Leg | null;
  inbound: Leg | null;
  fixed: TripFixed[];
  lodging: { booked: boolean; area: string | null } | null;
  interests: string[];
  pace: string | null;
  budget: string | null;
  missing: string[];
};

export type ValidateResult =
  | { ok: true; value: TripExtract; ask: string | null }
  | { ok: false; ask: string | null };

const KINDS = ["旅游", "办事", "混合"] as const;
const MODES = ["高铁", "飞机", "自驾", "其他"] as const;
const FIXED_TYPES = ["交通", "景点", "餐", "休息", "自由", "办事"] as const;

const ASK_CITY = "去哪座城市？";

function clip(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return null;
  return text.slice(0, max);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function padDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value.trim());
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function cleanTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${match[1]}:${match[2]}`;
}

function cleanMode(value: unknown): Leg["mode"] {
  return typeof value === "string" && (MODES as readonly string[]).includes(value) ? (value as Leg["mode"]) : null;
}

function cleanKind(value: unknown): TripExtract["kind"] {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value) ? (value as TripExtract["kind"]) : "旅游";
}

function cleanParty(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 20) return null;
  return value;
}

function cleanLeg(value: unknown): Leg | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const leg: Leg = {
    date: padDate(raw.date),
    time: cleanTime(raw.time),
    mode: cleanMode(raw.mode),
    from: clip(raw.from, 16),
    to: clip(raw.to, 16),
  };
  if (!leg.date && !leg.time && !leg.mode && !leg.from && !leg.to) return null;
  return leg;
}

function cleanFixed(value: unknown): TripFixed | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const title = clip(raw.title, 40);
  if (!title) return null;
  const type = typeof raw.type === "string" && (FIXED_TYPES as readonly string[]).includes(raw.type) ? (raw.type as ItemType) : null;
  return {
    date: padDate(raw.date),
    time: cleanTime(raw.time),
    endTime: cleanTime(raw.endTime),
    title,
    place: clip(raw.place, 40),
    type: type ?? (/体检|开会|会议|面试|出差/.test(title) ? "办事" : "自由"),
  };
}

function cleanLodging(value: unknown): TripExtract["lodging"] {
  const raw = asRecord(value);
  if (!raw) return null;
  const area = clip(raw.area, 24);
  if (raw.booked == null && !area) return null;
  return { booked: raw.booked === true, area };
}

function stringList(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const text = clip(entry, maxLen);
    if (!text || out.includes(text)) continue;
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Structural parse. Invalid JSON and non-objects become null so the caller can fall back to rules. */
export function parseExtract(input: unknown): TripExtract | null {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      return null;
    }
  }
  const raw = asRecord(value);
  if (!raw) return null;
  const destination = asRecord(raw.destination);
  return {
    kind: cleanKind(raw.kind),
    origin: clip(raw.origin, 16),
    destination: {
      city: clip(destination?.city, 16),
      area: clip(destination?.area, 24),
    },
    startDate: padDate(raw.startDate),
    endDate: padDate(raw.endDate),
    party: cleanParty(raw.party),
    outbound: cleanLeg(raw.outbound),
    inbound: cleanLeg(raw.inbound),
    fixed: Array.isArray(raw.fixed) ? raw.fixed.map(cleanFixed).filter((item): item is TripFixed => item != null) : [],
    lodging: cleanLodging(raw.lodging),
    interests: stringList(raw.interests, 8, 24),
    pace: clip(raw.pace, 40),
    budget: clip(raw.budget, 40),
    missing: stringList(raw.missing, 6, 40),
  };
}

function inWindow(iso: string | null, today: string): string | null {
  if (!iso) return null;
  const min = addDays(today, -1);
  const max = addDays(today, 60);
  if (iso < min || iso > max) return null;
  return iso;
}

function cityKey(name: string | null): string {
  return (name ?? "").replace(/(市|省)$/u, "");
}

function sameCity(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return cityKey(a) === cityKey(b);
}

function dropLegDate(leg: Leg | null, today: string): Leg | null {
  if (!leg) return null;
  const next = { ...leg, date: inWindow(leg.date, today) };
  if (!next.date && !next.time && !next.mode && !next.from && !next.to) return null;
  if (sameCity(next.from, next.to)) return null;
  return next;
}

function promptFor(now: Date): string {
  const today = shanghaiDate(now);
  const tomorrow = addDays(today, 1);
  const weekday = shanghaiWeekday(now);
  return `你是「路书」的抽取器。只把用户原话抽成 JSON，不做规划。
今天是 ${today} 周${weekday}（Asia/Shanghai）。「今天、明天、后天、周六、这周末、下周三」都换算成 YYYY-MM-DD。「下周」单独出现时从下周一开始。
规则：
- 只抽取用户明说的内容。没提到的字符串填 null，数组填 []。不要猜人数、预算、节奏，不要规划景点，不要编车次或航班号。
- fixed 只放两类：办事，或写了具体钟点的约定。体检、开会、会议、面试、出差是办事。没写钟点的办事 time 填 null，仍然留在 fixed，不能只写进 missing。早上、下午不是钟点。
- 没写钟点的景点、爬山、逛逛不要放进 fixed，写进 interests。同一件事不要同时出现在 fixed 和 interests，也不要再写同名或近义项（已有「泰山」就不要再写「爬泰山」或「爬山」）。
- 说了已订、订好了、已经订了，lodging.booked 就是 true。没提酒店就让 lodging 为 null。
- 返程没写交通方式时，mode 沿用去程；去程也没写才填 null。
- kind 只能是「旅游」「办事」「混合」。体检、开会、出差且没说要玩，用「办事」。又办事又玩，用「混合」。只说去玩、爬山，用「旅游」。
- destination.city 是目的地城市，不是出发地，也不是景点名。泰山的城市是泰安，乌镇、西塘的城市是嘉兴，西湖的城市是杭州，景点名放进 interests。听不出城市（例如「暖和的地方」「哪里」）就填 null，并在 missing 里写目的地。area 是市内区域，例如汉峪金谷。
- outbound 是去程，inbound 是返程。mode 只能是「高铁」「飞机」「自驾」「其他」或 null。
- fixed.type 只能是「交通」「景点」「餐」「休息」「自由」「办事」。
- 时间用 24 小时制 HH:mm。下午 2 点是 14:00，下午 4 点半是 16:30。
- 只输出一个 JSON 对象，不要 Markdown。字段：kind, origin, destination, startDate, endDate, party, outbound, inbound, fixed, lodging, interests, pace, budget, missing。

示例（今天是 ${today}）：
用户：我今天下午 2 点的高铁，从上海去往济南。明天早上体检，在汉峪金谷那边，我已经订好了附近的酒店。明天下午 4 点半返程
要点：kind=办事，origin=上海，destination.city=济南，destination.area=汉峪金谷，startDate=${today}，endDate=${tomorrow}，outbound.time=14:00，outbound.mode=高铁，inbound.date=${tomorrow}，inbound.time=16:30，inbound.mode=高铁，fixed 必须有 {date:${tomorrow}, time:null, title:体检, place:汉峪金谷, type:办事}，lodging.booked=true。体检不能放进 missing。
用户：下周三到周五去成都出差，周四下午 2 点开会
要点：fixed 必须有周四 14:00 的开会，type=办事，不能漏。
用户：想去爬泰山
要点：kind=旅游，destination.city=泰安，interests 含泰山，fixed 为 []。不要把「爬泰山」放进 fixed，也不要再写「爬山」。
用户：周六从杭州去乌镇
要点：origin=杭州，destination.city=嘉兴，interests 含乌镇。城市不要写成乌镇。`;
}

/**
 * Ask the model for a TripExtract. Failures, timeouts, and bad JSON return null.
 * Do not log the brief, the key, or the raw model text.
 */
export async function extractBrief(brief: string, now: Date, env: LlmEnv): Promise<TripExtract | null> {
  try {
    const result = await chatComplete({
      env: { ...env, timeoutMs: 15_000 },
      json: true,
      temperature: 0,
      messages: [
        { role: "system", content: promptFor(now) },
        { role: "user", content: brief.slice(0, 2000) },
      ],
    });
    return parseExtract(extractJson(result.content));
  } catch {
    return null;
  }
}

export function validateExtract(extract: TripExtract, now: Date, brief = ""): ValidateResult {
  const today = shanghaiDate(now);
  const value: TripExtract = {
    ...extract,
    destination: { ...extract.destination },
    outbound: extract.outbound ? { ...extract.outbound } : null,
    inbound: extract.inbound ? { ...extract.inbound } : null,
    fixed: extract.fixed.map((item) => ({ ...item })),
    lodging: extract.lodging ? { ...extract.lodging } : null,
    interests: extract.interests.slice(0, 8),
    missing: extract.missing.slice(0, 6),
  };

  value.origin = clip(value.origin, 16);
  value.destination.city = clip(value.destination.city, 16);
  value.destination.area = clip(value.destination.area, 24);
  value.pace = clip(value.pace, 40);
  value.budget = clip(value.budget, 40);
  value.interests = stringList(value.interests, 8, 24);
  value.missing = stringList(value.missing, 6, 40);
  value.fixed = value.fixed
    .slice(0, 10)
    .map((item) => ({
      ...item,
      title: clip(item.title, 40) ?? "",
      place: clip(item.place, 40),
      time: cleanTime(item.time),
      endTime: cleanTime(item.endTime),
    }))
    .filter((item) => item.title);

  value.startDate = inWindow(value.startDate, today);
  value.endDate = inWindow(value.endDate, today);
  value.outbound = dropLegDate(value.outbound, today);
  value.inbound = dropLegDate(value.inbound, today);
  value.fixed = value.fixed.flatMap((item) => {
    if (item.date && !inWindow(item.date, today)) return [];
    return [{ ...item, date: item.date ? inWindow(item.date, today) : null }];
  });

  const outboundDate = value.outbound?.date ?? null;
  const inboundDate = value.inbound?.date ?? null;
  const spanBroken =
    (value.startDate && value.endDate && (value.endDate < value.startDate || daysBetween(value.startDate, value.endDate) + 1 > 7)) ||
    false;
  if (spanBroken) {
    if (outboundDate && inboundDate && inboundDate >= outboundDate && daysBetween(outboundDate, inboundDate) + 1 <= 7) {
      value.startDate = outboundDate;
      value.endDate = inboundDate;
    } else {
      value.startDate = null;
      value.endDate = null;
    }
  }

  if (!value.destination.city || isVaguePlaceName(value.destination.city)) return { ok: false, ask: ASK_CITY };

  let ask: string | null = null;
  if (sameCity(value.origin, value.destination.city)) {
    value.origin = null;
    if (value.outbound && sameCity(value.outbound.from, value.outbound.to)) value.outbound = null;
    const route = matchTravelRoute(brief);
    if (route) {
      const stated = resolvePlaceToken(route.to);
      if (stated && !sameCity(stated, value.destination.city)) return { ok: false, ask: null };
    }
    ask = ASK_CITY;
  }

  const folded = foldUnclockedVisits(value.fixed, value.interests);
  value.fixed = folded.fixed;
  value.interests = folded.interests;
  return { ok: true, value, ask };
}
