import { guideFor, hasCityGuide, type Place } from "../cities";
import { citiesInText, cityByName } from "@lushu/tools/place";
import { parseBrief, parseZhNumber } from "../parse";
import { addDays, daysBetween, formatTime, inferStartDate, inferWeekdayDate, nextWeekMonday, parseTime, shanghaiDate, weekdayInWeek } from "./time";
import type { Assumption, ItemType, Roadbook, RoadbookItem } from "./types";

type ExtractInput = NonNullable<Roadbook["extract"]>;

export type DraftOptions = {
  id: string;
  now?: Date;
  random?: () => string;
};

function rng(random?: () => string): () => string {
  let n = 0;
  const next = random ?? (() => Math.random().toString(36).slice(2, 10));
  return () => {
    n += 1;
    const value = next().replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
    return value || `n${n}`;
  };
}

function inferredSource(note: string): RoadbookItem["source"] {
  return { kind: "推断", note };
}

function item(
  random: () => string,
  fields: Omit<RoadbookItem, "id" | "highlight" | "source" | "lat" | "lng" | "estimateSource"> &
    Partial<Pick<RoadbookItem, "source" | "lat" | "lng" | "estimateSource">>,
): RoadbookItem {
  const { source, lat, lng, estimateSource, ...rest } = fields;
  return {
    ...rest,
    id: `i_${random()}`,
    lat: lat ?? null,
    lng: lng ?? null,
    highlight: false,
    estimateSource: estimateSource ?? "推断",
    source: source ?? inferredSource("本地草稿"),
  };
}

function visitPlace(name: string, detail = "你点名要去的地方。开放时间和门票请出发前核实。"): Place {
  return {
    name,
    area: "景区",
    detail,
    indoor: false,
    cost: "mid",
    keywords: [name],
  };
}

const CLIMB_RE = /(?:泰山|黄山|华山|衡山|恒山|嵩山|峨眉山|庐山|普陀山|青城山|武当山|雁荡山|长白山|五台山)$/;

/** User explicitly asked to visit the hero again. Otherwise a must-go place is scheduled once. */
export function repeatRequested(brief: string): boolean {
  return /再去一次|去两次|去两趟|回头再去|再访|回访/.test(brief);
}

function isHero(place: Place, mustVisit: string | null): boolean {
  if (!mustVisit) return false;
  return place.name === mustVisit || place.name.includes(mustVisit) || mustVisit.includes(place.name);
}

function isFullDay(place: Place): boolean {
  if (place.fullDay) return true;
  if (CLIMB_RE.test(place.name)) return true;
  return place.area === "景区" && place.name.endsWith("山") && place.keywords.includes(place.name);
}

function sightPriority(place: Place, mustVisit: string | null): "必去" | "想去" {
  if (place.fullDay || isHero(place, mustVisit)) return "必去";
  return "想去";
}

function sightPool(city: string, mustVisit: string | null): Place[] {
  const guide = guideFor(city === "未写明的目的地" ? "待定城市" : city);
  const daytime = guide.places.filter((item) => !item.evening);
  const outdoor = daytime.filter((item) => !item.indoor);
  let pool = outdoor.length >= 4 ? outdoor : [...outdoor, ...daytime.filter((item) => item.indoor)];
  if (pool.length === 0) pool = [visitPlace(city === "未写明的目的地" ? "城区走走" : `${city}走走`, "开放时间请出发前核实。")];
  if (!mustVisit) return pool;
  const hit = guide.places.find((item) => item.name.includes(mustVisit) || mustVisit.includes(item.name));
  const must = hit ?? visitPlace(mustVisit);
  return [must, ...pool.filter((item) => item.name !== must.name)];
}

function claimSight(
  pool: Place[],
  used: Map<string, number>,
  mustVisit: string | null,
  allowRepeat: boolean,
): Place | null {
  const fresh = pool.find((place) => (used.get(place.name) ?? 0) === 0);
  if (fresh) {
    used.set(fresh.name, 1);
    return fresh;
  }
  if (!allowRepeat) return null;
  const again = pool.find((place) => isHero(place, mustVisit) && (used.get(place.name) ?? 0) < 2);
  if (!again) return null;
  used.set(again.name, (used.get(again.name) ?? 0) + 1);
  return again;
}

function fillerSight(used: Map<string, number>): Place {
  const options = ["城区再走一段", "公园里坐一会儿", "附近随便走走"];
  const name = options.find((item) => (used.get(item) ?? 0) === 0) ?? `再走走${used.size + 1}`;
  used.set(name, (used.get(name) ?? 0) + 1);
  return visitPlace(name, "赶时间可以整段拿掉。");
}

function hoursLabel(minutes: number): string {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

export type DayBuildOptions = {
  origin: string | null;
  withReturn?: boolean;
  mustVisit?: string | null;
  /** Names already placed, shared across days so a hero is not copied onto a later day. */
  used?: Map<string, number>;
  allowRepeat?: boolean;
};

export function itemsForDay(
  city: string,
  dayIndex: number,
  dayCount: number,
  random: () => string,
  options: DayBuildOptions,
): RoadbookItem[] {
  const guide = guideFor(city === "未写明的目的地" ? "待定城市" : city);
  const used = options.used ?? new Map<string, number>();
  const mustVisit = options.mustVisit ?? null;
  const allowRepeat = options.allowRepeat === true;
  const pool = sightPool(city, mustVisit);
  const first = claimSight(pool, used, mustVisit, allowRepeat) ?? fillerSight(used);
  const placeName = city === "未写明的目的地" ? "待定" : city;
  const arriving = Boolean(options.origin) && dayIndex === 1;
  const returning = Boolean(options.origin && options.withReturn && dayIndex === dayCount);
  if (isFullDay(first)) {
    return fullDayItems(random, {
      dayIndex,
      placeName,
      guide,
      place: first,
      mustVisit,
      origin: options.origin,
      arriving,
      returning,
    });
  }
  const second = claimSight(pool, used, mustVisit, allowRepeat) ?? fillerSight(used);
  const items: RoadbookItem[] = [];
  if (options.origin && dayIndex === 1 && options.origin !== placeName) {
    items.push(
      item(random, {
        dayIndex,
        startTime: "08:00",
        durationMinutes: 90,
        title: `从${options.origin}前往${placeName}`,
        place: options.origin,
        type: "交通",
        status: "待做",
        travelEstimateMinutes: 0,
        locked: false,
        priority: "必去",
        indoor: true,
        note: "时刻按出发理解。票和班次请自己查，路书不代订。",
      }),
    );
  }
  const morning = options.origin && dayIndex === 1 ? "10:00" : "09:00";
  items.push(
    item(random, {
      dayIndex,
      startTime: morning,
      durationMinutes: 40,
      title: guide.food[0] ?? "早餐",
      place: placeName,
      type: "餐",
      status: "待做",
      travelEstimateMinutes: 10,
      locked: false,
      priority: "想去",
      indoor: true,
    }),
  );
  items.push(
    item(random, {
      dayIndex,
      startTime: options.origin && dayIndex === 1 ? "11:00" : "10:00",
      durationMinutes: 120,
      title: first.name,
      place: `${placeName} · ${first.area}`,
      type: "景点",
      status: "待做",
      travelEstimateMinutes: 20,
      locked: false,
      priority: sightPriority(first, mustVisit),
      indoor: first.indoor,
      note: first.detail,
    }),
  );
  items.push(
    item(random, {
      dayIndex,
      startTime: "12:30",
      durationMinutes: 60,
      title: guide.food[1] ?? "午餐",
      place: placeName,
      type: "餐",
      status: "待做",
      travelEstimateMinutes: 15,
      locked: false,
      priority: "想去",
      indoor: true,
    }),
  );
  if (dayIndex === dayCount && options.withReturn && options.origin) {
    items.push(
      item(random, {
        dayIndex,
        startTime: "15:00",
        durationMinutes: 90,
        title: `返回${options.origin}`,
        place: placeName,
        type: "交通",
        status: "待做",
        travelEstimateMinutes: 15,
        locked: false,
        priority: "必去",
        indoor: true,
        note: "返程自己查班次。路书不代订。",
      }),
    );
  } else {
    items.push(
      item(random, {
        dayIndex,
        startTime: "14:00",
        durationMinutes: 100,
        title: second.name,
        place: `${placeName} · ${second.area}`,
        type: "景点",
        status: "待做",
        travelEstimateMinutes: 20,
        locked: false,
        priority: sightPriority(second, mustVisit),
        indoor: second.indoor,
        note: second.detail,
      }),
    );
    items.push(
      item(random, {
        dayIndex,
        startTime: "16:00",
        durationMinutes: 70,
        title: "可砍的闲逛",
        place: placeName,
        type: "自由",
        status: "待做",
        travelEstimateMinutes: 10,
        locked: false,
        priority: "可砍",
        indoor: false,
        note: "赶时间或累了就整段拿掉。",
      }),
    );
  }
  items.push(
    item(random, {
      dayIndex,
      startTime: "18:00",
      durationMinutes: 70,
      title: guide.food[2] ?? "晚饭",
      place: placeName,
      type: "餐",
      status: "待做",
      travelEstimateMinutes: 15,
      locked: false,
      priority: "想去",
      indoor: true,
    }),
  );
  if (!(dayIndex === dayCount && options.withReturn && options.origin)) {
    items.push(
      item(random, {
        dayIndex,
        startTime: "19:20",
        durationMinutes: 100,
        title: "可砍的夜走",
        place: placeName,
        type: "自由",
        status: "待做",
        travelEstimateMinutes: 10,
        locked: false,
        priority: "可砍",
        indoor: false,
        note: "晚了就先砍这一段。",
      }),
    );
  }
  return items;
}

function fullDayItems(
  random: () => string,
  options: {
    dayIndex: number;
    placeName: string;
    guide: { food: string[] };
    place: Place;
    mustVisit: string | null;
    origin: string | null;
    arriving: boolean;
    returning: boolean;
  },
): RoadbookItem[] {
  const { dayIndex, placeName, guide, place, mustVisit, origin, arriving, returning } = options;
  const durationMinutes = arriving && returning ? 330 : arriving || returning ? 360 : 420;
  const mountain = place.name.endsWith("山");
  const items: RoadbookItem[] = [];
  if (arriving && origin && origin !== placeName) {
    items.push(
      item(random, {
        dayIndex,
        startTime: "06:30",
        durationMinutes: 90,
        title: `从${origin}前往${placeName}`,
        place: origin,
        type: "交通",
        status: "待做",
        travelEstimateMinutes: 0,
        locked: false,
        priority: "必去",
        indoor: true,
        note: "时刻按出发理解。票和班次请自己查，路书不代订。",
      }),
    );
  }
  const climbStart = arriving ? "08:50" : "07:40";
  items.push(
    item(random, {
      dayIndex,
      startTime: arriving ? "08:10" : "07:00",
      durationMinutes: 30,
      title: guide.food[0] ?? "早餐",
      place: placeName,
      type: "餐",
      status: "待做",
      travelEstimateMinutes: 10,
      locked: false,
      priority: "想去",
      indoor: true,
      note: "出发前吃完，不要把正餐留在景区门口。",
    }),
  );
  items.push(
    item(random, {
      dayIndex,
      startTime: climbStart,
      durationMinutes,
      title: place.name,
      place: `${placeName} · ${place.area}`,
      type: "景点",
      status: "待做",
      travelEstimateMinutes: 20,
      locked: false,
      priority: sightPriority(place, mustVisit),
      indoor: place.indoor,
      note: mountain
        ? `登${place.name}按一整天排，大约 ${hoursLabel(durationMinutes)} 小时，含上下山。开放时间和路线请出发前核实。`
        : `${place.name}按一整天排，大约 ${hoursLabel(durationMinutes)} 小时，这一天不再叠别的景点。开放时间请出发前核实。`,
    }),
  );
  items.push(
    item(random, {
      dayIndex,
      startTime: arriving && returning ? "14:30" : returning ? "13:50" : arriving ? "15:10" : "15:00",
      durationMinutes: returning ? 40 : 60,
      title: guide.food[1] ?? "午餐",
      place: placeName,
      type: "餐",
      status: "待做",
      travelEstimateMinutes: 10,
      locked: false,
      priority: "想去",
      indoor: true,
    }),
  );
  if (returning && origin) {
    items.push(
      item(random, {
        dayIndex,
        startTime: arriving ? "15:20" : "14:40",
        durationMinutes: 90,
        title: `返回${origin}`,
        place: placeName,
        type: "交通",
        status: "待做",
        travelEstimateMinutes: 15,
        locked: false,
        priority: "必去",
        indoor: true,
        note: "返程自己查班次。路书不代订。",
      }),
    );
  } else {
    items.push(
      item(random, {
        dayIndex,
        startTime: "16:20",
        durationMinutes: 40,
        title: mountain ? "山下歇一歇" : "看完歇一歇",
        place: placeName,
        type: "休息",
        status: "待做",
        travelEstimateMinutes: 10,
        locked: false,
        priority: "可砍",
        indoor: true,
        note: "这一天的主行程已经够长，这里只是歇脚。",
      }),
    );
  }
  items.push(
    item(random, {
      dayIndex,
      startTime: "18:00",
      durationMinutes: 70,
      title: guide.food[2] ?? "晚饭",
      place: placeName,
      type: "餐",
      status: "待做",
      travelEstimateMinutes: 15,
      locked: false,
      priority: "想去",
      indoor: true,
    }),
  );
  return items;
}

function assumption(
  random: () => string,
  fields: Omit<Assumption, "id">,
): Assumption {
  return { id: `a_${random()}`, ...fields };
}

export type DraftKind = "旅游" | "办事" | "混合";

export type DraftLeg = {
  date: string | null;
  time: string | null;
  mode: "高铁" | "飞机" | "自驾" | "其他" | null;
  from: string | null;
  to: string | null;
};

export type DraftFixed = {
  date: string | null;
  time: string | null;
  endTime: string | null;
  title: string;
  place: string | null;
  type: ItemType;
};

export type DraftSpec = {
  brief: string;
  via: "rules" | "model";
  kind: DraftKind;
  city: string;
  area: string | null;
  origin: string | null;
  days: number;
  daysAssumed: boolean;
  partySummary: string;
  partyInferred: boolean;
  whenLabel: string | null;
  startDate: string | null;
  cityInferred: boolean;
  landmark: string | null;
  interests: string[];
  pace: string | null;
  paceInferred: boolean;
  whenInferred: boolean;
  slow: boolean;
  outbound: DraftLeg | null;
  inbound: DraftLeg | null;
  fixed: DraftFixed[];
  lodging: { booked: boolean; area: string | null } | null;
  ask: string | null;
};

const DAY_START = 8 * 60;
const DAY_LIMIT = 21 * 60 + 30;

function blankSpec(brief: string): DraftSpec {
  return {
    brief,
    via: "rules",
    kind: "旅游",
    city: "未写明的目的地",
    area: null,
    origin: null,
    days: 3,
    daysAssumed: true,
    partySummary: "人数没写清，按 2 人估算",
    partyInferred: true,
    whenLabel: null,
    startDate: null,
    cityInferred: true,
    landmark: null,
    interests: [],
    pace: null,
    paceInferred: true,
    whenInferred: true,
    slow: false,
    outbound: null,
    inbound: null,
    fixed: [],
    lodging: null,
    ask: null,
  };
}

function partyFromCount(count: number | null): { summary: string; inferred: boolean } {
  if (count == null) return { summary: "人数没写清，按 2 人估算", inferred: true };
  if (count === 1) return { summary: "一个人", inferred: false };
  if (count === 2) return { summary: "两个人", inferred: false };
  return { summary: `${count} 个人`, inferred: false };
}

function clockToHHMM(part: string | undefined, hourRaw: string, minuteRaw: string | undefined): string | null {
  const token = hourRaw === "俩" ? "两" : hourRaw;
  const parsed = /^\d+$/.test(token) ? Number(token) : parseZhNumber(token);
  if (parsed == null) return null;
  let hour = parsed;
  let minute = 0;
  if (minuteRaw === "半") minute = 30;
  else if (minuteRaw === "一刻") minute = 15;
  else if (minuteRaw === "三刻") minute = 45;
  else if (minuteRaw && /^\d+$/.test(minuteRaw)) minute = Number(minuteRaw);
  if (!part && hour < 8) return null;
  if ((part === "下午" || part === "晚上" || part === "傍晚") && hour < 12) hour += 12;
  if (part === "中午" && hour < 11) hour += 12;
  if (hour > 23 || minute > 59) return null;
  return formatTime(hour * 60 + minute);
}

function clocksIn(brief: string): { time: string; index: number }[] {
  const hits: { time: string; index: number }[] = [];
  const spoken = /(上午|下午|晚上|中午|早上|凌晨|傍晚)?\s*(\d{1,2}|[零〇一二两俩三四五六七八九十]{1,3})\s*[点时](?:\s*(半|一刻|三刻|\d{1,2}))?/g;
  for (const match of brief.matchAll(spoken)) {
    if (match.index == null || !match[2]) continue;
    const time = clockToHHMM(match[1], match[2], match[3]);
    if (time) hits.push({ time, index: match.index });
  }
  for (const match of brief.matchAll(/(\d{2}):(\d{2})/g)) {
    if (match.index == null || !match[1] || !match[2]) continue;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) continue;
    hits.push({ time: `${match[1]}:${match[2]}`, index: match.index });
  }
  return hits;
}

function sentenceBounds(brief: string, index: number): { start: number; end: number } {
  let start = 0;
  for (const mark of ["。", "！", "？"]) {
    const at = brief.lastIndexOf(mark, index - 1);
    if (at >= start) start = at + 1;
  }
  let end = brief.length;
  for (const mark of ["。", "！", "？"]) {
    const at = brief.indexOf(mark, index);
    if (at >= 0 && at < end) end = at;
  }
  return { start, end };
}

function nearestClock(hits: { time: string; index: number }[], index: number, brief: string, others: number[] = []): string | null {
  const bounds = sentenceBounds(brief, index);
  let best: { time: string; index: number } | null = null;
  let dist = Number.POSITIVE_INFINITY;
  for (const hit of hits) {
    if (hit.index < bounds.start || hit.index > bounds.end) continue;
    const gap = Math.abs(hit.index - index);
    if (gap < dist) {
      dist = gap;
      best = hit;
    }
  }
  if (!best) return null;
  for (const other of others) {
    if (other >= 0 && Math.abs(best.index - other) < dist) return null;
  }
  return best.time;
}

function dateNear(brief: string, index: number, today: string, now: Date): string | null {
  const slice = brief.slice(Math.max(0, index - 16), Math.min(brief.length, index + 8));
  if (slice.includes("后天")) return addDays(today, 2);
  if (slice.includes("明天")) return addDays(today, 1);
  if (slice.includes("今天")) return today;
  const weekHits = [...slice.matchAll(/(?:星期|礼拜|周)([一二三四五六日天])/g)];
  const week = weekHits.length > 0 ? weekHits[weekHits.length - 1] : null;
  if (!week?.[1]) return null;
  if (/下周/.test(brief)) {
    const monday = nextWeekMonday(now);
    return weekdayInWeek(monday, week[1]);
  }
  const label = `周${week[1] === "天" ? "日" : week[1]}`;
  return inferWeekdayDate(label, now);
}

function applySpokenDates(spec: DraftSpec, text: string, now: Date): void {
  const today = shanghaiDate(now);
  if (/当天回|当日回|当天往返|当日往返/.test(text)) {
    spec.days = 1;
    spec.daysAssumed = false;
  } else if (/今天/.test(text) && /明天/.test(text) && /返程|回来|返回/.test(text)) {
    spec.days = 2;
    spec.daysAssumed = false;
    spec.startDate = today;
    spec.whenInferred = false;
  }
  const span = text.match(/下周([一二三四五六日天])\s*到\s*周([一二三四五六日天])/);
  if (span?.[1] && span[2]) {
    const monday = nextWeekMonday(now);
    const start = weekdayInWeek(monday, span[1]);
    const end = weekdayInWeek(monday, span[2]);
    if (start && end && end >= start) {
      spec.startDate = start;
      spec.days = Math.min(7, daysBetween(start, end) + 1);
      spec.daysAssumed = false;
      spec.whenLabel = span[0];
      spec.whenInferred = false;
    }
  } else if (/下周(?![一二三四五六日天末])/.test(text)) {
    spec.startDate = nextWeekMonday(now);
    spec.whenLabel = "下周";
    spec.whenInferred = true;
  }
  if (!spec.startDate && /明天/.test(text) && /出发|去往|前往|高铁|飞机|当天|当日/.test(text)) {
    spec.startDate = addDays(today, 1);
    spec.whenInferred = false;
  } else if (!spec.startDate && /今天/.test(text) && /出发|去往|高铁|飞机/.test(text)) {
    spec.startDate = today;
    spec.whenInferred = false;
  }
  if (!spec.startDate && !/下周/.test(text)) {
    const week = text.match(/(?:星期|礼拜|周)([一二三四五六日天])/);
    if (week?.[1]) {
      const label = `周${week[1] === "天" ? "日" : week[1]}`;
      const date = inferWeekdayDate(label, now);
      if (date) {
        spec.startDate = date;
        spec.whenLabel = label;
        spec.whenInferred = false;
      }
    }
  }
}

function alignInboundMode(spec: DraftSpec): void {
  if (spec.inbound && !spec.inbound.mode && spec.outbound?.mode) {
    spec.inbound = { ...spec.inbound, mode: spec.outbound.mode };
  }
}

const STATED_EVENTS: { title: string; re: RegExp }[] = [
  { title: "体检", re: /体检/g },
  { title: "开会", re: /开会|会议/g },
  { title: "面试", re: /面试/g },
];

function applyBriefFacts(spec: DraftSpec, now: Date): void {
  alignInboundMode(spec);
  const text = spec.brief;
  if (/酒店|宾馆/.test(text) && /订好|订了|已订|已经订/.test(text)) {
    spec.lodging = { booked: true, area: spec.lodging?.area ?? spec.area };
  }
  const today = shanghaiDate(now);
  const clocks = clocksIn(text);
  const goAt = text.search(/高铁|动车|飞机|航班|出发|去往|前往/);
  const backAt = text.search(/返程|返回|回来|当天回|当日往返/);
  const blockers = [goAt, backAt].filter((index) => index >= 0);
  for (const event of STATED_EVENTS) {
    for (const match of text.matchAll(event.re)) {
      if (match.index == null) continue;
      const clock = nearestClock(clocks, match.index, text, blockers);
      const date = dateNear(text, match.index, today, now) ?? spec.startDate;
      const existing = spec.fixed.find((item) => item.title.includes(event.title) || event.title.includes(item.title));
      if (!existing) {
        spec.fixed.push({
          date,
          time: clock,
          endTime: null,
          title: event.title,
          place: spec.area,
          type: "办事",
        });
        continue;
      }
      if (!clock) existing.time = null;
      else if (!existing.time) existing.time = clock;
      if (date && !existing.date) existing.date = date;
    }
  }
}

function attachTransport(spec: DraftSpec, text: string, now: Date): void {
  const today = shanghaiDate(now);
  const origin = spec.origin;
  const city = spec.city;
  if (!origin || city === "未写明的目的地" || city === origin) return;
  if (!/高铁|动车|飞机|航班|火车|自驾|开车|返程|返回|回来|当天回|当日往返/.test(text)) return;
  const clocks = clocksIn(text);
  const mode = modeOf(text);
  const goAt = text.search(/高铁|动车|飞机|航班|出发|去往|前往/);
  const backAt = text.search(/返程|返回|回来|当天回|当日往返/);
  const goTime = goAt >= 0 ? nearestClock(clocks, goAt, text, [backAt]) : null;
  const backTime = backAt >= 0 ? nearestClock(clocks, backAt, text, [goAt]) : null;
  spec.outbound = {
    date: (goAt >= 0 ? dateNear(text, goAt, today, now) : null) ?? spec.startDate,
    time: goTime,
    mode,
    from: origin,
    to: city,
  };
  if (backAt >= 0) {
    spec.inbound = {
      date:
        dateNear(text, backAt, today, now) ??
        (spec.days === 1 ? spec.outbound.date : spec.startDate ? addDays(spec.startDate, spec.days - 1) : null),
      time: backTime,
      mode,
      from: city,
      to: origin,
    };
  }
}

function modeOf(text: string): DraftLeg["mode"] {
  if (/高铁|动车/.test(text)) return "高铁";
  if (/飞机|航班/.test(text)) return "飞机";
  if (/自驾|开车/.test(text)) return "自驾";
  if (/火车|大巴|客车/.test(text)) return "其他";
  return null;
}

function extractArea(brief: string): string | null {
  const match = brief.match(/在([\u4e00-\u9fa5]{2,12})(?:那边|附近|一带)/);
  const token = match?.[1];
  if (!token || cityByName(token)) return null;
  return token;
}

function kindOf(brief: string): DraftKind {
  const business = /体检|开会|会议|出差|面试|看病|复诊/.test(brief);
  const leisure = /玩玩|逛逛|走走|旅游|旅行|景点|爬山|迪士尼|周边玩/.test(brief);
  if (business && leisure) return "混合";
  if (business) return "办事";
  return "旅游";
}

export function specFromRules(brief: string, now = new Date()): DraftSpec {
  const text = brief.trim();
  const parsed = parseBrief(text);
  const spec = blankSpec(text);
  spec.via = "rules";
  let city = parsed.destinations[0] ?? "未写明的目的地";
  let origin = parsed.origin;
  if (origin && city === origin) {
    spec.ask = "去哪座城市？";
    city = "未写明的目的地";
    origin = null;
  }
  spec.city = city;
  spec.origin = origin;
  spec.days = parsed.days;
  spec.daysAssumed = parsed.daysAssumed;
  spec.partySummary = parsed.party.summary;
  spec.partyInferred = parsed.party.kind === "unknown";
  spec.whenLabel = parsed.whenLabel;
  spec.whenInferred = !parsed.whenLabel;
  spec.slow = parsed.themes.includes("slow");
  spec.kind = kindOf(text);
  spec.area = extractArea(text);
  spec.landmark = citiesInText(text).find((hit) => hit.city === city)?.landmark ?? null;
  const named = city !== "未写明的目的地" && text.includes(city);
  spec.cityInferred = !named && city !== "未写明的目的地";
  applySpokenDates(spec, text, now);
  if (!spec.ask && origin && city !== "未写明的目的地" && city !== origin) attachTransport(spec, text, now);
  if (spec.city === "未写明的目的地") spec.ask = spec.ask ?? "去哪座城市？";
  applyBriefFacts(spec, now);
  return spec;
}

export function specFromExtract(extract: ExtractInput, _now = new Date(), ask: string | null = null, brief = ""): DraftSpec {
  const spec = blankSpec(brief);
  spec.via = "model";
  spec.kind = extract.kind;
  spec.city = extract.destination.city ?? "未写明的目的地";
  spec.area = extract.destination.area;
  spec.origin = extract.origin && extract.origin !== spec.city ? extract.origin : null;
  spec.ask = ask;
  if (spec.ask) {
    spec.city = "未写明的目的地";
    spec.origin = null;
    spec.cityInferred = true;
  }
  const start = extract.startDate;
  const end = extract.endDate;
  if (start && end && end >= start) {
    const span = daysBetween(start, end) + 1;
    if (span >= 1 && span <= 7) {
      spec.days = span;
      spec.daysAssumed = false;
      spec.startDate = start;
      spec.whenLabel = end === start ? start : `${start} 至 ${end}`;
    }
  } else if (start) {
    spec.startDate = start;
    spec.whenLabel = start;
    spec.days = 3;
    spec.daysAssumed = true;
  }
  const party = partyFromCount(extract.party);
  spec.partySummary = party.summary;
  spec.partyInferred = party.inferred;
  spec.interests = extract.interests.slice(0, 8);
  spec.landmark = spec.interests[0] ?? null;
  spec.pace = extract.pace;
  spec.paceInferred = !extract.pace;
  spec.slow = Boolean(extract.pace && /松|慢/.test(extract.pace));
  spec.outbound = extract.outbound ? { ...extract.outbound } : null;
  spec.inbound = extract.inbound ? { ...extract.inbound } : null;
  spec.fixed = extract.fixed.map((item) => ({ ...item }));
  spec.lodging = extract.lodging ? { ...extract.lodging } : null;
  spec.cityInferred = false;
  if (!extract.destination.city || (spec.ask && spec.city === "未写明的目的地")) {
    spec.city = "未写明的目的地";
    spec.cityInferred = true;
    spec.ask = spec.ask ?? "去哪座城市？";
  }
  spec.whenInferred = !spec.startDate && !spec.whenLabel;
  if (!spec.ask) applyBriefFacts(spec, _now);
  return spec;
}

export function specForQuestion(brief: string, ask: string): DraftSpec {
  const spec = blankSpec(brief);
  spec.via = "model";
  spec.ask = ask;
  spec.city = "未写明的目的地";
  spec.cityInferred = true;
  spec.whenInferred = true;
  return spec;
}

function legacyItems(spec: DraftSpec, random: () => string): RoadbookItem[] {
  const used = new Map<string, number>();
  return Array.from({ length: spec.days }, (_, index) =>
    itemsForDay(spec.city, index + 1, spec.days, random, {
      origin: spec.origin,
      withReturn: Boolean(spec.origin) && spec.days <= 3,
      mustVisit: spec.interests[0] ?? spec.landmark,
      used,
      allowRepeat: repeatRequested(spec.brief),
    }),
  ).flat();
}

function useLegacy(spec: DraftSpec): boolean {
  if (spec.kind !== "旅游") return false;
  if (spec.outbound || spec.inbound || spec.fixed.length > 0) return false;
  if (spec.lodging?.booked) return false;
  return true;
}

function modeMinutes(mode: DraftLeg["mode"]): number {
  if (mode === "高铁") return 180;
  if (mode === "飞机") return 150;
  if (mode === "自驾") return 240;
  return 120;
}

function clampDuration(startTime: string, want: number): number {
  const start = parseTime(startTime);
  if (start == null) return Math.min(Math.max(want, 30), 180);
  const room = 23 * 60 + 30 - start;
  return Math.max(30, Math.min(want, room));
}

function selfTrip(title: string): boolean {
  return /^从(.+)前往\1$/.test(title);
}

function overlaps(start: number, duration: number, items: RoadbookItem[], day: number): boolean {
  const end = start + duration;
  return items.some((item) => {
    if (item.dayIndex !== day) return false;
    const other = parseTime(item.startTime);
    if (other == null) return false;
    return start < other + item.durationMinutes && end > other;
  });
}

function placeFree(
  items: RoadbookItem[],
  day: number,
  earliest: number,
  latest: number,
  preferred: number,
  duration: number,
): number | null {
  let start = Math.max(earliest, preferred);
  start = Math.ceil(start / 10) * 10;
  while (start + duration <= latest) {
    if (!overlaps(start, duration, items, day)) return start;
    start += 10;
  }
  return null;
}

function dayIndexFor(date: string | null, start: string, days: number): number {
  if (!date) return 1;
  const index = daysBetween(start, date) + 1;
  if (!Number.isFinite(index) || index < 1) return 1;
  return Math.min(days, index);
}

function statedSource(): RoadbookItem["source"] {
  return { kind: "推断", note: "来自你的原话" };
}

function anchoredItems(spec: DraftSpec, random: () => string, now: Date): RoadbookItem[] {
  const days = spec.days;
  const start = spec.startDate ?? shanghaiDate(now);
  const label = spec.city === "未写明的目的地" ? "待定" : spec.city;
  const items: RoadbookItem[] = [];
  const outboundMark: { day: number; end: number }[] = [];
  const inboundMark: { day: number; start: number }[] = [];

  const pushLeg = (leg: DraftLeg, day: number, title: string, place: string, statedTime = Boolean(leg.time)) => {
    if (selfTrip(title)) return;
    const time = leg.time ?? "08:00";
    const duration = clampDuration(time, modeMinutes(leg.mode));
    items.push(
      item(random, {
        dayIndex: day,
        startTime: time,
        durationMinutes: duration,
        title,
        place,
        type: "交通",
        status: "待做",
        travelEstimateMinutes: modeMinutes(leg.mode),
        estimateSource: "推断",
        locked: statedTime,
        priority: "必去",
        indoor: true,
        note: statedTime
          ? "来自你的原话。时长是估计，班次和到达时间请自己查。路书不代订。"
          : "时间推断。原话没写钟点，先放在这个时间。时长是估计，班次请自己查。路书不代订。",
        source: statedTime ? statedSource() : inferredSource("时间推断"),
      }),
    );
    const startMin = parseTime(time) ?? DAY_START;
    if (leg === spec.outbound) outboundMark.push({ day, end: startMin + duration });
    else inboundMark.push({ day, start: startMin });
  };

  if (spec.outbound) {
    const from = spec.outbound.from ?? spec.origin;
    const to = spec.outbound.to ?? (spec.city === "未写明的目的地" ? null : spec.city);
    if (from && to && from !== to) {
      pushLeg(spec.outbound, dayIndexFor(spec.outbound.date, start, days), `从${from}前往${to}`, from);
    }
  }
  if (spec.inbound) {
    const from = spec.inbound.from ?? (spec.city === "未写明的目的地" ? null : spec.city);
    const to = spec.inbound.to ?? spec.origin;
    if (from && to && from !== to) {
      const day = dayIndexFor(spec.inbound.date ?? (spec.startDate ? addDays(spec.startDate, days - 1) : null), start, days);
      const statedTime = Boolean(spec.inbound.time);
      const time = spec.inbound.time ?? "18:00";
      pushLeg({ ...spec.inbound, time }, day, `从${from}前往${to}`, from, statedTime);
      const depart = parseTime(time);
      if (depart != null && depart - 60 >= DAY_START) {
        const buffer = depart - 60;
        if (!overlaps(buffer, 60, items, day)) {
          items.push(
            item(random, {
              dayIndex: day,
              startTime: formatTime(buffer),
              durationMinutes: 60,
              title: "去车站",
              place: `${label} · 车站`,
              type: "交通",
              status: "待做",
              travelEstimateMinutes: 60,
              estimateSource: "推断",
              locked: false,
              priority: "必去",
              indoor: true,
              note: "返程前预留 60 分钟去车站，时刻是推断。",
              source: inferredSource("返程前预留去车站的时间"),
            }),
          );
        }
      }
    }
  }

  for (const fixed of spec.fixed) {
    const day = dayIndexFor(fixed.date, start, days);
    const duration = fixed.type === "办事" ? 120 : 90;
    const depart = inboundMark.find((mark) => mark.day === day)?.start ?? DAY_LIMIT;
    const windowEnd = Math.min(DAY_LIMIT, depart);
    const clockStated = Boolean(fixed.time);
    const stated = clockStated && fixed.time ? parseTime(fixed.time) : null;
    const statedFits =
      stated != null && stated >= DAY_START && stated + 30 <= windowEnd && !overlaps(stated, Math.min(duration, windowEnd - stated), items, day);
    const startMin = statedFits
      ? stated
      : placeFree(items, day, DAY_START, windowEnd, stated != null && stated < windowEnd ? stated : 8 * 60, Math.min(duration, 150));
    if (startMin == null) continue;
    const clockNote = clockStated ? "来自你的原话。" : "时间推断。钟点没写，先放在 08:00。";
    items.push(
      item(random, {
        dayIndex: day,
        startTime: formatTime(startMin),
        durationMinutes: clampDuration(formatTime(startMin), duration),
        title: fixed.title,
        place: fixed.place ? `${label} · ${fixed.place}` : `${label} · ${spec.area ?? "附近"}`,
        type: fixed.type,
        status: "待做",
        travelEstimateMinutes: 15,
        estimateSource: "推断",
        locked: clockStated,
        priority: "必去",
        indoor: true,
        note: clockNote,
        source: clockStated ? statedSource() : inferredSource("时间推断"),
      }),
    );
  }

  const guide = guideFor(label === "待定" ? "待定城市" : spec.city);
  const unknown = spec.city !== "未写明的目的地" && !hasCityGuide(spec.city);
  const used = new Map<string, number>();
  const pool = sightPool(spec.city, spec.interests[0] ?? spec.landmark);
  let walks = 0;
  let sights = 0;
  const mealPlace = spec.area ? `${label} · ${spec.area}` : `${label} · 附近`;

  for (let day = 1; day <= days; day += 1) {
    const arrived = outboundMark.find((mark) => mark.day === day);
    const returning = inboundMark.find((mark) => mark.day === day);
    const station = items.find((entry) => entry.dayIndex === day && entry.title === "去车站");
    const stationStart = station ? parseTime(station.startTime) : null;
    const earliest = arrived ? arrived.end : DAY_START;
    const latest = stationStart ?? returning?.start ?? DAY_LIMIT;
    if (latest - earliest < 40) continue;
    const addAt = (preferred: number, duration: number, fields: Parameters<typeof item>[1]) => {
      const startMin = placeFree(items, day, earliest, latest, preferred, duration);
      if (startMin == null) return false;
      const title = fields.title;
      if (selfTrip(title)) return false;
      items.push(
        item(random, {
          ...fields,
          dayIndex: day,
          startTime: formatTime(startMin),
          durationMinutes: duration,
        }),
      );
      return true;
    };
    if (spec.kind === "旅游") {
      if (earliest <= 9 * 60 + 30) {
        addAt(9 * 60, 40, {
          dayIndex: day,
          startTime: "09:00",
          durationMinutes: 40,
          title: guide.food[0] ?? "早餐",
          place: mealPlace,
          type: "餐",
          status: "待做",
          travelEstimateMinutes: 10,
          locked: false,
          priority: "想去",
          indoor: true,
          source: inferredSource(unknown ? "通用模板，地点是推断" : "本地草稿"),
        });
      }
      const first = claimSight(pool, used, spec.interests[0] ?? spec.landmark, false);
      if (first && sights < 4 && latest - earliest >= 90) {
        const interest = spec.interests.some((name) => first.name.includes(name) || name.includes(first.name));
        if (
          addAt(Math.max(earliest, 10 * 60), isFullDay(first) ? Math.min(360, latest - earliest - 30) : 100, {
            dayIndex: day,
            startTime: "10:00",
            durationMinutes: 100,
            title: first.name,
            place: `${label} · ${first.area}`,
            type: "景点",
            status: "待做",
            travelEstimateMinutes: 20,
            locked: false,
            priority: interest ? "必去" : sightPriority(first, spec.landmark),
            indoor: first.indoor,
            note: unknown ? "通用模板，地点是推断，不是别的城市的景点。" : first.detail,
            source: inferredSource(unknown ? "通用模板，地点是推断" : "本地草稿"),
          })
        ) {
          sights += 1;
        }
      }
      addAt(12 * 60, 50, {
        dayIndex: day,
        startTime: "12:00",
        durationMinutes: 50,
        title: guide.food[1] ?? "午餐",
        place: mealPlace,
        type: "餐",
        status: "待做",
        travelEstimateMinutes: 10,
        locked: false,
        priority: "想去",
        indoor: true,
      });
      const second = claimSight(pool, used, spec.interests[0] ?? spec.landmark, false);
      if (second && sights < 4 && latest - earliest >= 90) {
        const interest = spec.interests.some((name) => second.name.includes(name) || name.includes(second.name));
        if (
          addAt(Math.max(earliest, 14 * 60), 100, {
            dayIndex: day,
            startTime: "14:00",
            durationMinutes: 100,
            title: second.name,
            place: `${label} · ${second.area}`,
            type: "景点",
            status: "待做",
            travelEstimateMinutes: 20,
            locked: false,
            priority: interest ? "必去" : sightPriority(second, spec.landmark),
            indoor: second.indoor,
            note: unknown ? "通用模板，地点是推断，不是别的城市的景点。" : second.detail,
            source: inferredSource(unknown ? "通用模板，地点是推断" : "本地草稿"),
          })
        ) {
          sights += 1;
        }
      }
      if (!returning) {
        addAt(16 * 60, 70, {
          dayIndex: day,
          startTime: "16:00",
          durationMinutes: 70,
          title: "可砍的闲逛",
          place: mealPlace,
          type: "自由",
          status: "待做",
          travelEstimateMinutes: 10,
          locked: false,
          priority: "可砍",
          indoor: false,
          note: "赶时间或累了就整段拿掉。",
        });
      }
      addAt(18 * 60, 70, {
        dayIndex: day,
        startTime: "18:00",
        durationMinutes: 70,
        title: guide.food[2] ?? "晚饭",
        place: mealPlace,
        type: "餐",
        status: "待做",
        travelEstimateMinutes: 15,
        locked: false,
        priority: "想去",
        indoor: true,
      });
      if (!returning) {
        addAt(19 * 60 + 20, 90, {
          dayIndex: day,
          startTime: "19:20",
          durationMinutes: 90,
          title: "可砍的夜走",
          place: mealPlace,
          type: "自由",
          status: "待做",
          travelEstimateMinutes: 10,
          locked: false,
          priority: "可砍",
          indoor: false,
          note: "晚了就先砍这一段。",
        });
      }
    } else {
      if (earliest <= 13 * 60) {
        addAt(12 * 60, 50, {
          dayIndex: day,
          startTime: "12:00",
          durationMinutes: 50,
          title: "附近吃饭",
          place: mealPlace,
          type: "餐",
          status: "待做",
          travelEstimateMinutes: 10,
          locked: false,
          priority: "想去",
          indoor: true,
          note: "只补附近的一餐，不安排景点。",
        });
      }
      if (earliest <= 19 * 60) {
        addAt(Math.max(earliest, 17 * 60 + 30), 50, {
          dayIndex: day,
          startTime: "18:00",
          durationMinutes: 50,
          title: "附近吃饭",
          place: mealPlace,
          type: "餐",
          status: "待做",
          travelEstimateMinutes: 10,
          locked: false,
          priority: "想去",
          indoor: true,
          note: "只补附近的一餐，不安排景点。",
        });
      }
      addAt(Math.max(earliest, 18 * 60), 80, {
        dayIndex: day,
        startTime: "19:00",
        durationMinutes: 80,
        title: spec.lodging?.booked ? "回酒店休息" : "回住处休息",
        place: mealPlace,
        type: "休息",
        status: "待做",
        travelEstimateMinutes: 10,
        locked: false,
        priority: "想去",
        indoor: true,
        note: spec.lodging?.booked ? "酒店已经订了。入住时间请自己核对。" : "回住处休息。",
      });
      if (spec.kind === "办事" && walks < 1) {
        if (
          addAt(Math.max(earliest, 19 * 60), 40, {
            dayIndex: day,
            startTime: "19:30",
            durationMinutes: 40,
            title: "就近散步",
            place: mealPlace,
            type: "自由",
            status: "待做",
            travelEstimateMinutes: 10,
            locked: false,
            priority: "可砍",
            indoor: false,
            note: "赶时间可以整段拿掉。",
          })
        ) {
          walks += 1;
        }
      }
      if (spec.kind === "混合" && sights < 2 && latest - earliest >= 90) {
        const place = claimSight(pool, used, spec.interests[0] ?? spec.landmark, false);
        if (place) {
          const interest = spec.interests.some((name) => place.name.includes(name) || name.includes(place.name));
          if (
            addAt(Math.max(earliest, 10 * 60), 90, {
              dayIndex: day,
              startTime: "10:00",
              durationMinutes: 90,
              title: place.name,
              place: `${label} · ${place.area}`,
              type: "景点",
              status: "待做",
              travelEstimateMinutes: 20,
              locked: false,
              priority: interest ? "必去" : "想去",
              indoor: place.indoor,
              note: unknown ? "通用模板，地点是推断，不是别的城市的景点。" : place.detail,
              source: inferredSource(unknown ? "通用模板，地点是推断" : "本地草稿"),
            })
          ) {
            sights += 1;
          }
        }
      }
    }
  }
  return items.filter((entry) => !selfTrip(entry.title));
}

function verifyLines(spec: DraftSpec): string[] {
  const lines: string[] = [];
  if (spec.kind !== "办事") lines.push("开放时间、闭馆日、要不要预约，出发前再核实");
  lines.push("用餐只是建议。路书不代订、不收款", "当天再看一眼天气");
  if (spec.outbound) lines.push("去程班次、到达时间自己查。路书不代订。");
  if (spec.fixed.some((item) => /体检/.test(item.title)) || /体检/.test(spec.brief)) {
    lines.push("体检是否需要空腹，出发前问清楚");
  }
  if (spec.inbound && spec.city !== "未写明的目的地") {
    lines.push(`返程车站（如${spec.city}西 / ${spec.city}东）`);
  } else if (spec.inbound) {
    lines.push("返程从哪一站走，自己核对班次");
  }
  if (spec.lodging?.booked || /订好了|已经订/.test(spec.brief)) lines.push("酒店入住时间自己核对");
  return lines;
}

export function buildDraftFromSpec(spec: DraftSpec, options: DraftOptions): Roadbook {
  const now = options.now ?? new Date();
  const random = rng(options.random);
  const explicitStart = spec.startDate ?? spec.outbound?.date ?? null;
  const resolvedStart = explicitStart ?? inferStartDate(spec.whenLabel, now);
  const ready: DraftSpec = {
    ...spec,
    startDate: explicitStart,
    days: Math.min(7, Math.max(1, spec.days || 1)),
  };
  const items = (
    ready.ask ? [] : useLegacy(ready) ? legacyItems(ready, random) : anchoredItems({ ...ready, startDate: resolvedStart }, random, now)
  ).filter((entry) => !selfTrip(entry.title));
  const city = ready.city;
  const cityInferred = ready.cityInferred;
  const stated = (inferred: boolean) => (inferred ? undefined : "从你的原话读出");
  const assumptions: Assumption[] = [
    assumption(random, {
      key: "city",
      label: "目的地",
      value: city === "未写明的目的地" ? "待定" : city,
      inferred: cityInferred || city === "未写明的目的地",
      detail:
        cityInferred && ready.landmark
          ? `由「${ready.landmark}」推断为${city}`
          : city === "未写明的目的地"
            ? "句子里没有认出城市"
            : stated(false),
    }),
    assumption(random, {
      key: "days",
      label: "天数",
      value: `${ready.days} 天`,
      inferred: ready.daysAssumed,
      detail: ready.daysAssumed ? "没写天数，先按这个写" : stated(false),
    }),
    assumption(random, {
      key: "party",
      label: "人数",
      value: ready.partySummary,
      inferred: ready.partyInferred,
      detail: ready.partyInferred ? "人数没写清" : stated(false),
    }),
    assumption(random, {
      key: "when",
      label: "时间",
      value: ready.whenLabel ?? ready.startDate ?? "日期未定",
      inferred: ready.whenInferred,
      detail: ready.whenInferred
        ? ready.whenLabel === "下周"
          ? "下周从下周一开始，日期是推断"
          : undefined
        : ready.via === "model" || ready.startDate
          ? "从你的原话读出"
          : undefined,
    }),
    assumption(random, {
      key: "origin",
      label: "出发",
      value: ready.origin ?? "当地集合",
      inferred: !ready.origin,
      detail: ready.origin ? "从你的原话读出" : undefined,
    }),
    assumption(random, {
      key: "pace",
      label: "节奏",
      value: ready.pace ?? (ready.slow ? "松一点" : "正常步行"),
      inferred: ready.paceInferred,
      detail: ready.paceInferred ? "路程分钟数是推断，不是导航" : "从你的原话读出",
    }),
  ];
  const createdAt = now.toISOString();
  const question = ready.ask
    ? { id: "city", prompt: ready.ask }
    : city === "未写明的目的地"
      ? { id: "city", prompt: "去哪座城市？" }
      : null;
  const inferredLabels = assumptions.filter((item) => item.inferred).map((item) => item.label);
  const statusLine = question
    ? items.length === 0
      ? "先确认去哪座城市，再排行程。"
      : "先出了骨架。只差一个城市，其余都标在假设上。"
    : inferredLabels.length > 0
      ? `草稿已出 · 推断了${inferredLabels.join("、")}`
      : "草稿已出";
  const bookStart = resolvedStart;
  return {
    id: options.id,
    createdAt,
    updatedAt: createdAt,
    brief: ready.brief,
    title: `${city === "未写明的目的地" ? "待定行程" : city} · ${ready.days} 天`,
    city,
    startDate: bookStart,
    assumptions,
    items,
    weather: [],
    verifyChecklist: verifyLines(ready).map((text) => ({ id: `v_${random()}`, text })),
    patchHistory: [
      {
        id: `p_${random()}`,
        at: createdAt,
        label: "生成草稿",
        kind: "draft",
        ops: items.map((entry) => ({ op: "add" as const, item: { ...entry, source: { ...entry.source } } })),
      },
    ],
    undo: null,
    question,
    statusLine,
  };
}

export function buildDraft(brief: string, options: DraftOptions): Roadbook {
  const now = options.now ?? new Date();
  return buildDraftFromSpec(specFromRules(brief, now), { ...options, now });
}
