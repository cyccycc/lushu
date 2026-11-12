import { guideFor, hasCityGuide, type Place } from "../cities";
import { citiesInText, cityByName, resolvePlaceToken } from "@lushu/tools/place";
import { parseBrief, parseZhNumber, statedPartyCount } from "../parse";
import { addDays, daysBetween, formatTime, inferStartDate, inferWeekdayDate, nextWeekMonday, noteForPlacedClock, parseTime, shanghaiDate, weekdayInWeek } from "./time";
import { DEFAULT_OWNER_ID, type Assumption, type ItemType, type Roadbook, type RoadbookItem } from "./types";

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

const TEMPLATE_SIGHTS = new Set([
  "中心城区步行",
  "本地市场",
  "城市公园",
  "老街走一段",
  "城区再走一段",
  "公园里坐一会儿",
  "附近随便走走",
  "再走走",
  "城区走走",
]);

function isTemplateSight(item: Pick<RoadbookItem, "title" | "note" | "source">): boolean {
  if (TEMPLATE_SIGHTS.has(item.title)) return true;
  if (/的博物馆$/.test(item.title) && /室内底|通用模板|推断/.test(`${item.note ?? ""}`)) return true;
  return /通用模板|地点是推断/.test(`${item.note ?? ""} ${item.source.note ?? ""}`);
}

/** Attach a search hit only when it actually names a non-template sight. */
export function citeRetrievedSights(
  items: RoadbookItem[],
  hit: { title: string; url?: string | null } | null | undefined,
  fetchedAt: string,
): RoadbookItem[] {
  const title = hit?.title?.trim() ?? "";
  const url = hit?.url ?? "";
  if (!title || !/^https?:\/\//.test(url)) return items;
  return items.map((item) => {
    if (item.type !== "景点" || item.source.kind !== "推断") return item;
    if (isTemplateSight(item) || !title.includes(item.title)) return item;
    return {
      ...item,
      source: {
        kind: "检索",
        url,
        fetchedAt,
        note: title.slice(0, 200),
      },
    };
  });
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
  if (GENERIC_VISIT.test(place.name)) return false;
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
  const indoor = daytime.filter((item) => item.indoor);
  let pool = [...outdoor, ...indoor];
  if (pool.length === 0) pool = [visitPlace(city === "未写明的目的地" ? "城区走走" : `${city}走走`, "开放时间请出发前核实。")];
  if (!mustVisit) return pool;
  const hit = guide.places.find((item) => item.name.includes(mustVisit) || mustVisit.includes(item.name));
  const must = hit ?? visitPlace(mustVisit);
  return [must, ...pool.filter((item) => item.name !== must.name)];
}

function peekSight(
  pool: Place[],
  used: Map<string, number>,
  mustVisit: string | null,
  allowRepeat: boolean,
  skip?: (place: Place) => boolean,
): Place | null {
  const fresh = pool.find((place) => (used.get(place.name) ?? 0) === 0 && !skip?.(place));
  if (fresh) return fresh;
  if (!allowRepeat) return null;
  return pool.find((place) => isHero(place, mustVisit) && (used.get(place.name) ?? 0) < 2 && !skip?.(place)) ?? null;
}

function commitSight(used: Map<string, number>, place: Place): void {
  used.set(place.name, (used.get(place.name) ?? 0) + 1);
}

function claimSight(
  pool: Place[],
  used: Map<string, number>,
  mustVisit: string | null,
  allowRepeat: boolean,
  skip?: (place: Place) => boolean,
): Place | null {
  const place = peekSight(pool, used, mustVisit, allowRepeat, skip);
  if (!place) return null;
  commitSight(used, place);
  return place;
}

function takeSight(
  pool: Place[],
  used: Map<string, number>,
  mustVisit: string | null,
  allowRepeat: boolean,
  skip?: (place: Place) => boolean,
): Place | null {
  return claimSight(pool, used, mustVisit, allowRepeat, skip);
}

function freeActivity(
  random: () => string,
  dayIndex: number,
  placeName: string,
  startTime: string,
  durationMinutes: number,
): RoadbookItem {
  return item(random, {
    dayIndex,
    startTime,
    durationMinutes,
    title: "自由活动",
    place: placeName,
    type: "自由",
    status: "待做",
    travelEstimateMinutes: 10,
    locked: false,
    priority: "可砍",
    indoor: false,
    note: "这一天没有新的景点了，自己安排。赶时间可以拿掉。",
  });
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

const INFERRED_RETURN_NOTE = "原话没提返程，按短途补的。不回去就删掉";
const VOICED_RETURN_CHIP = "钟点没写，按当天傍晚估";

/** Same-day return words with no clock of their own. A bare 「当天」 does not count. */
function voicedReturnPhrase(brief: string): string | null {
  if (statedReturnClock(brief)) return null;
  const match = brief.match(/当天回|当天往返|当日往返|当日回/);
  return match?.[0] ?? null;
}

export function returnEstimateNote(brief: string): string {
  const phrase = voicedReturnPhrase(brief);
  if (!phrase) return INFERRED_RETURN_NOTE;
  return `原话说${phrase}，钟点没写。不回去就删掉`;
}

export function returnAssumptionValue(brief: string, days: number, clock: string): string {
  if (voicedReturnPhrase(brief)) return VOICED_RETURN_CHIP;
  return `没写，按第 ${days} 天 ${clock} 估`;
}

function inferredReturnItem(
  random: () => string,
  dayIndex: number,
  origin: string,
  placeName: string,
  mode: "高铁" | "飞机" | "自驾" | "其他" | null,
  note = INFERRED_RETURN_NOTE,
  startTime?: string,
  rideMinutes?: number,
): RoadbookItem {
  const ride = rideMinutes ?? modeMinutes(mode, placeName, origin);
  const start = startTime ?? formatTime(fitInferredReturn(ride, 0).start);
  const startMin = parseTime(start) ?? 18 * 60;
  return item(random, {
    dayIndex,
    startTime: start,
    durationMinutes: ride,
    title: `返回${origin}`,
    place: placeName,
    type: "交通",
    status: "待做",
    travelEstimateMinutes: ride,
    estimateSource: "推断",
    locked: false,
    priority: "必去",
    indoor: true,
    note: withOverflow(note, startMin, ride),
    source: inferredSource("时间推断"),
  });
}

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
  const placeName = city === "未写明的目的地" ? "待定" : city;
  const arriving = Boolean(options.origin) && dayIndex === 1;
  const returning = Boolean(options.origin && options.withReturn && dayIndex === dayCount);
  const arrivalRide =
    arriving && options.origin && options.origin !== placeName ? modeMinutes(null, options.origin, placeName) : 0;
  const arrivalFloor = arrivalRide > 0 ? alignTen(8 * 60 + arrivalRide) : null;
  const lead = pool.find((place) => (used.get(place.name) ?? 0) === 0);
  if (lead && isFullDay(lead) && !(arrivalFloor != null && arrivalFloor > 11 * 60)) {
    claimSight(pool, used, mustVisit, allowRepeat);
    return presentItems(
      fullDayItems(random, {
        dayIndex,
        placeName,
        guide,
        place: lead,
        mustVisit,
        origin: options.origin,
        arriving,
        returning,
      }),
    );
  }
  const items: RoadbookItem[] = [];
  let floor: number | null = null;
  if (options.origin && dayIndex === 1 && options.origin !== placeName) {
    const ride = modeMinutes(null, options.origin, placeName);
    items.push(
      item(random, {
        dayIndex,
        startTime: "08:00",
        durationMinutes: ride,
        title: `从${options.origin}前往${placeName}`,
        place: options.origin,
        type: "交通",
        status: "待做",
        travelEstimateMinutes: ride,
        locked: false,
        priority: "必去",
        indoor: true,
        note: "时刻按出发理解。票和班次请自己查，路书不代订。",
      }),
    );
    floor = alignTen(8 * 60 + ride);
  }
  const late = floor != null && floor > 16 * 60;
  const skipLateFull = (place: Place) => Boolean(floor != null && floor > 11 * 60 && isFullDay(place));
  let cursor = 0;
  let placedFree = false;
  const poolWaiting = () => pool.some((place) => (used.get(place.name) ?? 0) === 0 && skipLateFull(place));
  const poolHasSight = () => pool.some((place) => (used.get(place.name) ?? 0) === 0 && !skipLateFull(place));
  const offerFree = (preferred: number, duration: number) => {
    if (placedFree || poolHasSight() || poolWaiting()) return;
    placeAt(preferred, duration, (start) => freeActivity(random, dayIndex, placeName, start, duration));
    placedFree = true;
  };
  const placeAt = (preferred: number, duration: number, build: (start: string) => RoadbookItem) => {
    const startMin = alignTen(Math.max(preferred, floor ?? 0, cursor));
    if (startMin >= DAY_LIMIT) return;
    items.push(build(formatTime(startMin)));
    cursor = startMin + duration;
  };
  const sightAt = (place: Place, preferred: number, duration: number) => {
    placeAt(preferred, duration, (start) =>
      item(random, {
        dayIndex,
        startTime: start,
        durationMinutes: duration,
        title: place.name,
        place: `${placeName} · ${place.area}`,
        type: "景点",
        status: "待做",
        travelEstimateMinutes: 20,
        locked: false,
        priority: sightPriority(place, mustVisit),
        indoor: place.indoor,
        note: place.detail,
      }),
    );
  };
  if (floor == null || floor <= 9 * 60 + 30) {
    placeAt(options.origin && dayIndex === 1 ? 10 * 60 : 9 * 60, 40, (start) =>
      item(random, {
        dayIndex,
        startTime: start,
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
  }
  const lunchAt = 12 * 60 + 30;
  let heldFullDay = false;
  if (!late) {
    const morningPreferred = options.origin && dayIndex === 1 ? 11 * 60 : 10 * 60;
    const morningStart = alignTen(Math.max(morningPreferred, floor ?? 0, cursor));
    if (lunchAt - morningStart >= 40) {
      const morning = takeSight(pool, used, mustVisit, allowRepeat, skipLateFull);
      if (morning && isFullDay(morning)) {
        heldFullDay = true;
        sightAt(morning, morningStart, Math.min(360, Math.max(120, lunchAt - morningStart)));
      } else if (morning) {
        sightAt(morning, morningStart, Math.min(120, lunchAt - morningStart));
      } else offerFree(morningStart, Math.min(100, Math.max(40, lunchAt - morningStart)));
    }
    placeAt(lunchAt, 60, (start) =>
      item(random, {
        dayIndex,
        startTime: start,
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
  }
  if (returning && options.origin) {
    const ride = modeMinutes(null, placeName, options.origin);
    const backStart = fitInferredReturn(ride, 0).start;
    if (floor == null || backStart >= floor) {
      const stationStart = backStart - 60;
      if ((floor == null || stationStart >= floor) && stationStart >= cursor) {
        items.push(
          item(random, {
            dayIndex,
            startTime: formatTime(stationStart),
            durationMinutes: 60,
            title: "去车站",
            place: `${placeName} · 车站`,
            type: "交通",
            status: "待做",
            travelEstimateMinutes: 60,
            locked: false,
            priority: "必去",
            indoor: true,
            note: "返程前预留 60 分钟去车站，时刻是推断。",
            source: inferredSource("返程前预留去车站的时间"),
          }),
        );
      }
      items.push(inferredReturnItem(random, dayIndex, options.origin, placeName, null, INFERRED_RETURN_NOTE, formatTime(backStart), ride));
    }
    return presentItems(items);
  }
  const dinnerAt = 18 * 60;
  if (!late) {
    const afternoonStart = alignTen(Math.max(14 * 60, floor ?? 0, cursor));
    if (dinnerAt - afternoonStart >= 40) {
      if (!heldFullDay) {
        const afternoon = takeSight(pool, used, mustVisit, allowRepeat, skipLateFull);
        if (afternoon) sightAt(afternoon, afternoonStart, Math.min(100, dinnerAt - afternoonStart));
        else offerFree(afternoonStart, Math.min(100, Math.max(40, dinnerAt - afternoonStart)));
      }
    }
    const strollStart = alignTen(Math.max(16 * 60, floor ?? 0, cursor));
    if (dinnerAt - strollStart >= 70) {
      placeAt(16 * 60, 70, (start) =>
        item(random, {
          dayIndex,
          startTime: start,
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
  }
  placeAt(dinnerAt, 70, (start) =>
    item(random, {
      dayIndex,
      startTime: start,
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
  if (!late) {
    const nightStart = alignTen(Math.max(19 * 60 + 20, floor ?? 0, cursor));
    if (nightStart + 100 <= DAY_LIMIT) {
      placeAt(19 * 60 + 20, 100, (start) =>
        item(random, {
          dayIndex,
          startTime: start,
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
  }
  return presentItems(items);
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
  let floor: number | null = null;
  if (arriving && origin && origin !== placeName) {
    const ride = modeMinutes(null, origin, placeName);
    items.push(
      item(random, {
        dayIndex,
        startTime: "06:30",
        durationMinutes: ride,
        title: `从${origin}前往${placeName}`,
        place: origin,
        type: "交通",
        status: "待做",
        travelEstimateMinutes: ride,
        locked: false,
        priority: "必去",
        indoor: true,
        note: "时刻按出发理解。票和班次请自己查，路书不代订。",
      }),
    );
    floor = alignTen(6 * 60 + 30 + ride);
  }
  if (floor != null) {
    const breakfastFloor = Math.max(floor, 7 * 60);
    let cursor = breakfastFloor;
    if (breakfastFloor <= 9 * 60 + 30) {
      const breakfastStart = alignTen(breakfastFloor);
      items.push(
        item(random, {
          dayIndex,
          startTime: formatTime(breakfastStart),
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
      cursor = breakfastStart + 30;
    } else {
      cursor = alignTen(floor);
    }
    if (cursor <= 16 * 60) {
      const climbAt = alignTen(cursor);
      const room = Math.max(40, (returning ? 17 * 60 : 18 * 60) - climbAt);
      const span = Math.min(durationMinutes, room);
      items.push(
        item(random, {
          dayIndex,
          startTime: formatTime(climbAt),
          durationMinutes: span,
          title: place.name,
          place: `${placeName} · ${place.area}`,
          type: "景点",
          status: "待做",
          travelEstimateMinutes: 20,
          locked: false,
          priority: sightPriority(place, mustVisit),
          indoor: place.indoor,
          note: mountain
            ? `登${place.name}按一整天排，大约 ${hoursLabel(span)} 小时，含上下山。开放时间和路线请出发前核实。`
            : `${place.name}按一整天排，大约 ${hoursLabel(span)} 小时，这一天不再叠别的景点。开放时间请出发前核实。`,
        }),
      );
    }
    if (returning && origin) {
      const backStart = fitInferredReturn(modeMinutes(null, placeName, origin), 0).start;
      if (backStart >= floor) {
        const stationStart = backStart - 60;
        if (stationStart >= floor) {
          items.push(
            item(random, {
              dayIndex,
              startTime: formatTime(stationStart),
              durationMinutes: 60,
              title: "去车站",
              place: `${placeName} · 车站`,
              type: "交通",
              status: "待做",
              travelEstimateMinutes: 60,
              locked: false,
              priority: "必去",
              indoor: true,
              note: "返程前预留 60 分钟去车站，时刻是推断。",
              source: inferredSource("返程前预留去车站的时间"),
            }),
          );
        }
        items.push(inferredReturnItem(random, dayIndex, origin, placeName, null));
      }
    } else {
      const dinnerStart = alignTen(Math.max(18 * 60, floor));
      if (dinnerStart < DAY_LIMIT) {
        items.push(
          item(random, {
            dayIndex,
            startTime: formatTime(dinnerStart),
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
      }
    }
    return items;
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
    const backStart = fitInferredReturn(modeMinutes(null, placeName, origin), 0).start;
    items.push(
      item(random, {
        dayIndex,
        startTime: formatTime(backStart - 60),
        durationMinutes: 60,
        title: "去车站",
        place: `${placeName} · 车站`,
        type: "交通",
        status: "待做",
        travelEstimateMinutes: 60,
        locked: false,
        priority: "必去",
        indoor: true,
        note: "返程前预留 60 分钟去车站，时刻是推断。",
        source: inferredSource("返程前预留去车站的时间"),
      }),
    );
    items.push(inferredReturnItem(random, dayIndex, origin, placeName, null, INFERRED_RETURN_NOTE, formatTime(backStart)));
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
  if (!returning) {
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
  }
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
  /** Departure clock. Empty when the user only stated an arrival. */
  time: string | null;
  /** Arrival clock from 「X点到」. Not a sight time. */
  arriveTime?: string | null;
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

function alignTen(minutes: number): number {
  return Math.ceil(minutes / 10) * 10;
}
/** Climbs and stated morning clocks can start before the usual 08:00. */
const EARLY_FLOOR = 5 * 60;
const CLIMB_MINUTES = 7 * 60;

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

type ClockHit = { time: string; index: number; end: number; arrival: boolean; rangeEnd: string | null };

/** 「3点到8点」 is a range. 「3点到」 / 「3点到乌镇」 is an arrival. */
function isArrivalTail(after: string): boolean {
  const trimmed = after.trimStart();
  if (!/^(?:到达|抵达|到)/.test(trimmed)) return false;
  const rest = trimmed.replace(/^(?:到达|抵达|到)/, "").trimStart();
  if (/^(?:\d|[零〇一二两三四五六七八九十])/.test(rest)) return false;
  return true;
}

const CLOCK_WORD = "上午|下午|晚上|中午|早上|凌晨|傍晚";
const CLOCK_HOUR = "\\d{1,2}|[零〇一二两俩三四五六七八九十]{1,3}";
const CLOCK_MINUTE = "半|一刻|三刻|\\d{1,2}";

function afternoonPartBefore(brief: string, index: number): string | undefined {
  const bounds = sentenceBounds(brief, index);
  const slice = brief.slice(bounds.start, index);
  const found = [...slice.matchAll(/下午|晚上|傍晚|中午/g)];
  return found.length > 0 ? found[found.length - 1]?.[0] : undefined;
}

function rangeEndClock(
  startPart: string | undefined,
  endPart: string | undefined,
  startTime: string,
  hourRaw: string,
  minuteRaw: string | undefined,
): string | null {
  const parsed = clockToHHMM(endPart || startPart, hourRaw, minuteRaw);
  if (!parsed) return null;
  const startMin = parseTime(startTime);
  let endMin = parseTime(parsed);
  if (startMin == null || endMin == null) return null;
  if (!endPart && endMin <= startMin && endMin + 12 * 60 > startMin && endMin + 12 * 60 < 24 * 60) {
    endMin += 12 * 60;
  }
  if (endMin <= startMin) return null;
  return formatTime(endMin);
}

function rangesIn(brief: string): { start: string; end: string; index: number; endIndex: number }[] {
  const re = new RegExp(
    `(${CLOCK_WORD})?\\s*(${CLOCK_HOUR})\\s*[点时](?:\\s*(${CLOCK_MINUTE}))?\\s*(?:到|至)\\s*(?:(${CLOCK_WORD})\\s*)?(${CLOCK_HOUR})\\s*[点时](?:\\s*(${CLOCK_MINUTE}))?`,
    "g",
  );
  const found: { start: string; end: string; index: number; endIndex: number }[] = [];
  for (const match of brief.matchAll(re)) {
    if (match.index == null || !match[2] || !match[5]) continue;
    const start = clockToHHMM(match[1], match[2], match[3]);
    if (!start) continue;
    const end = rangeEndClock(match[1], match[4], start, match[5], match[6]);
    if (!end) continue;
    found.push({ start, end, index: match.index, endIndex: match.index + match[0].length });
  }
  return found;
}

function clocksIn(brief: string): ClockHit[] {
  const ranges = rangesIn(brief);
  const hits: ClockHit[] = [];
  const covered = (index: number) => ranges.some((range) => index >= range.index && index < range.endIndex);
  for (const range of ranges) {
    hits.push({ time: range.start, index: range.index, end: range.endIndex, arrival: false, rangeEnd: range.end });
  }
  const spoken = new RegExp(`(${CLOCK_WORD})?\\s*(${CLOCK_HOUR})\\s*[点时](?:\\s*(${CLOCK_MINUTE}))?`, "g");
  for (const match of brief.matchAll(spoken)) {
    if (match.index == null || !match[2] || covered(match.index)) continue;
    const end = match.index + match[0].length;
    const arrival = isArrivalTail(brief.slice(end));
    let time = clockToHHMM(match[1], match[2], match[3]);
    if (!time && !match[1] && arrival) {
      const inherited = afternoonPartBefore(brief, match.index);
      if (inherited) time = clockToHHMM(inherited, match[2], match[3]);
    }
    if (!time) continue;
    hits.push({ time, index: match.index, end, arrival, rangeEnd: null });
  }
  for (const match of brief.matchAll(/(\d{2}):(\d{2})/g)) {
    if (match.index == null || !match[1] || !match[2] || covered(match.index)) continue;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) continue;
    const end = match.index + match[0].length;
    hits.push({ time: `${match[1]}:${match[2]}`, index: match.index, end, arrival: isArrivalTail(brief.slice(end)), rangeEnd: null });
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

function nearestClock(hits: ClockHit[], index: number, brief: string, others: number[] = []): ClockHit | null {
  const bounds = sentenceBounds(brief, index);
  let best: ClockHit | null = null;
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
  return best;
}

function returnWordIndex(brief: string): number {
  for (const match of brief.matchAll(/返程|回来|返回|回程|当天回|当日往返|当日回/g)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    if (brief[index - 1] === "不") continue;
    return index;
  }
  return -1;
}

/** A return clock the brief actually stated. Arrival clocks that only echo 「X点到」 do not count. */
export function statedReturnClock(brief: string): string | null {
  const backAt = returnWordIndex(brief);
  if (backAt < 0) return null;
  const clocks = clocksIn(brief).filter((hit) => !hit.rangeEnd);
  const goAt = brief.search(/高铁|动车|飞机|航班|火车|出发|去往|前往/);
  const blockers = goAt >= 0 ? [goAt] : [];
  const spoken = nearestClock(
    clocks.filter((hit) => !hit.arrival),
    backAt,
    brief,
    blockers,
  );
  if (spoken) return spoken.time;
  const arrival = nearestClock(
    clocks.filter((hit) => hit.arrival),
    backAt,
    brief,
    blockers,
  );
  return arrival?.time ?? null;
}

function refusesReturn(brief: string): boolean {
  return /单程|不回来|不返回|不返程|然后去|一路玩到/.test(brief);
}

/** Short trips get an editable evening return unless the brief said not to come back, or already named a return clock. */
export function wantsInferredReturn(input: { brief: string; origin: string | null; city: string; days: number }): boolean {
  if (refusesReturn(input.brief) || statedReturnClock(input.brief)) return false;
  if (!input.origin || input.city === "未写明的目的地" || input.city === input.origin) return false;
  return input.days <= 3;
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

const SAME_DAY_TRIP = /当天回|当日往返|当日回|只玩一天|一日游/;

/** A date range or a named return day. A clock like 「5点到」 is not an end date. */
function briefStatesEndDate(brief: string): boolean {
  if (/(?:周|星期|礼拜)[一二三四五六日天]\s*(?:到|至)\s*(?:周|星期|礼拜)?[一二三四五六日天]/.test(brief)) return true;
  if (/\d{1,2}\s*月\s*\d{1,2}\s*[日号][\s\S]{0,16}(?:到|至|—|-|~|～)[\s\S]{0,12}\d{1,2}\s*[日号]/.test(brief)) return true;
  if (/(?:今天|明天|后天|今晚|明日|后日)\s*(?:早上|上午|下午|晚上|中午|傍晚)?\s*(?:回|返回|返程)/.test(brief)) return true;
  if (/(?:回|返回|返程)\s*(?:在)?\s*(?:今天|明天|后天|今晚|明日)/.test(brief)) return true;
  return false;
}

function keepsSameDaySpan(brief: string, parsed: { days: number; daysAssumed: boolean }): boolean {
  if (SAME_DAY_TRIP.test(brief)) return true;
  return !parsed.daysAssumed && parsed.days === 1;
}

/**
 * Models often set endDate = startDate when the brief never named a length.
 * That guess must not become a 1-day trip. A real 1-day brief, or an explicit end date, stays.
 */
function guessedSameDayEnd(
  brief: string,
  start: string | null,
  end: string | null,
  parsed: { days: number; daysAssumed: boolean },
): boolean {
  if (!start || !end || end !== start) return false;
  if (keepsSameDaySpan(brief, parsed)) return false;
  if (briefStatesEndDate(brief)) return false;
  return true;
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
          time: clock?.time ?? null,
          endTime: clock?.rangeEnd ?? null,
          title: event.title,
          place: spec.area,
          type: "办事",
        });
        continue;
      }
      if (!clock) existing.time = null;
      else if (!existing.time) {
        existing.time = clock.time;
        if (clock.rangeEnd) existing.endTime = clock.rangeEnd;
      }
      if (date && !existing.date) existing.date = date;
    }
  }
  applySpokenSchedule(spec, now);
  alignDepartureClock(spec);
  alignReturnHonesty(spec);
}

/** Keep a spoken departure on the outbound. An arrival clock must not occupy that field. */
function alignDepartureClock(spec: DraftSpec): void {
  const clocks = clocksIn(spec.brief).filter((hit) => !hit.arrival && !hit.rangeEnd);
  const goAt = spec.brief.search(/高铁|动车|飞机|航班|火车|出发|去往|前往/);
  if (goAt < 0) return;
  const backAt = returnWordIndex(spec.brief);
  const hit = nearestClock(clocks, goAt, spec.brief, backAt >= 0 ? [backAt] : []);
  if (!hit) return;
  const arrivals = new Set(clocksIn(spec.brief).filter((item) => item.arrival).map((item) => item.time));
  if (spec.outbound?.time && !arrivals.has(spec.outbound.time)) return;
  const city = spec.city === "未写明的目的地" ? null : spec.city;
  const from = spec.outbound?.from ?? spec.origin;
  const to = spec.outbound?.to ?? city;
  if (!from || !to || from === to) return;
  spec.outbound = {
    date: spec.outbound?.date ?? spec.startDate,
    time: hit.time,
    arriveTime: spec.outbound?.arriveTime ?? null,
    mode: spec.outbound?.mode ?? modeOf(spec.brief),
    from,
    to,
  };
}

/** Drop a return clock the user never stated, including one that only copies 「X点到」. */
function alignReturnHonesty(spec: DraftSpec): void {
  const stated = statedReturnClock(spec.brief);
  if (refusesReturn(spec.brief) && !stated) {
    spec.inbound = null;
    return;
  }
  if (stated) {
    const city = spec.city === "未写明的目的地" ? null : spec.city;
    const mode = spec.inbound?.mode ?? spec.outbound?.mode ?? modeOf(spec.brief);
    if (!spec.inbound && spec.origin && city && city !== spec.origin) {
      spec.inbound = {
        date: spec.startDate ? addDays(spec.startDate, Math.max(0, spec.days - 1)) : null,
        time: stated,
        mode,
        from: city,
        to: spec.origin,
      };
      return;
    }
    if (spec.inbound) spec.inbound = { ...spec.inbound, time: stated, mode: spec.inbound.mode ?? mode };
    return;
  }
  if (returnWordIndex(spec.brief) < 0) {
    spec.inbound = null;
    return;
  }
  if (spec.inbound?.time) spec.inbound = { ...spec.inbound, time: null };
}

function attachTransport(spec: DraftSpec, text: string, now: Date): void {
  const today = shanghaiDate(now);
  const origin = spec.origin;
  const city = spec.city;
  if (!origin || city === "未写明的目的地" || city === origin) return;
  // Attach whenever the two cities differ. 出差 and 「从A去B」 do not need 高铁 or 出发.
  // A clock is written onto the leg only when it sits beside 出发 or a ride word.
  const clocks = clocksIn(text).filter((hit) => !hit.arrival && !hit.rangeEnd);
  const mode = modeOf(text);
  const goAt = text.search(/高铁|动车|飞机|航班|出发|去往|前往/);
  const backAt = text.search(/返程|返回|回来|当天回|当日往返/);
  const goTime = goAt >= 0 ? nearestClock(clocks, goAt, text, [backAt])?.time ?? null : null;
  const backTime = backAt >= 0 ? nearestClock(clocks, backAt, text, [goAt])?.time ?? null : null;
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

function visitMentions(brief: string): { name: string; index: number }[] {
  const mentions: { name: string; index: number }[] = [];
  const push = (name: string, index: number) => {
    const key = canonicalVisitName(name).slice(0, 24);
    if (!key || GENERIC_VISIT.test(key)) return;
    if (mentions.some((item) => sameVisit(item.name, key))) return;
    mentions.push({ name: key, index });
  };
  for (const hit of citiesInText(brief)) push(hit.landmark, hit.index);
  for (const match of brief.matchAll(/(?:去爬|去登|爬|登)([\u4e00-\u9fa5]{2,8})/g)) {
    if (match.index == null || !match[1]) continue;
    push(match[1], match.index + match[0].lastIndexOf(match[1]));
  }
  return mentions;
}

/** 「下午3点到」 is when the traveler arrives, not when a sight starts. */
function applyArrivalClock(spec: DraftSpec, now: Date): void {
  const arrivals = clocksIn(spec.brief).filter((hit) => hit.arrival);
  const pick = arrivals[0];
  if (!pick) return;
  const backAt = spec.brief.search(/返程|返回|回来|当天回|当日往返/);
  const goAt = spec.brief.search(/去|出发|前往|去往|飞往|飞到/);
  const forReturn = backAt >= 0 && (goAt < 0 || Math.abs(pick.index - backAt) < Math.abs(pick.index - goAt));
  const chosen =
    arrivals.find((hit) => {
      if (!forReturn) return backAt < 0 || Math.abs(hit.index - backAt) > Math.abs(hit.index - Math.max(goAt, 0));
      return Math.abs(hit.index - backAt) <= 16;
    }) ?? pick;
  const city = spec.city === "未写明的目的地" ? null : spec.city;
  const today = shanghaiDate(now);
  const date = dateNear(spec.brief, chosen.index, today, now) ?? spec.startDate;
  const target = forReturn ? spec.inbound : spec.outbound;
  const otherClocks = clocksIn(spec.brief).filter((hit) => !hit.arrival);
  const statedDeparture = Boolean(target?.time && target.time !== chosen.time && otherClocks.some((hit) => hit.time === target.time));
  const next: DraftLeg = {
    date: target?.date ?? date,
    time: statedDeparture ? target?.time ?? null : null,
    arriveTime: chosen.time,
    mode: target?.mode ?? modeOf(spec.brief),
    from: target?.from ?? (forReturn ? city : spec.origin),
    to: target?.to ?? (forReturn ? spec.origin : city),
  };
  if (forReturn) spec.inbound = next;
  else spec.outbound = next;
  const restored: string[] = [];
  spec.fixed = spec.fixed.filter((item) => {
    if (item.time !== chosen.time) return true;
    if (item.type === "办事" || ERRAND_TITLE.test(item.title)) return true;
    if (!isVisitTitle(item)) return true;
    restored.push(item.title);
    return false;
  });
  if (restored.length > 0) spec.interests = normalizeVisitNames([...spec.interests, ...restored]);
}

/** A clock next to a named sight stays on that sight. Arrival clocks are not reused. */
function applyClockedVisits(spec: DraftSpec, now: Date): void {
  const clocks = clocksIn(spec.brief).filter((hit) => !hit.arrival);
  if (clocks.length === 0) return;
  const today = shanghaiDate(now);
  const blockers = [...spec.brief.matchAll(/高铁|动车|飞机|航班|出发|返程|返回|回来|体检|开会|会议|面试/g)]
    .map((match) => match.index ?? -1)
    .filter((index) => index >= 0);
  const clocked: string[] = [];
  for (const mention of visitMentions(spec.brief)) {
    const clock = nearestClock(clocks, mention.index, spec.brief, blockers);
    if (!clock) continue;
    const existing = spec.fixed.find((item) => sameVisit(item.title, mention.name));
    const date = dateNear(spec.brief, mention.index, today, now) ?? spec.startDate;
    if (existing) {
      existing.time = clock.time;
      if (clock.rangeEnd) existing.endTime = clock.rangeEnd;
      existing.title = mention.name;
      if (!ERRAND_TITLE.test(existing.title)) existing.type = "景点";
      if (!existing.date) existing.date = date;
    } else {
      spec.fixed.push({
        date,
        time: clock.time,
        endTime: clock.rangeEnd,
        title: mention.name,
        place: mention.name,
        type: "景点",
      });
    }
    clocked.push(mention.name);
  }
  if (clocked.length === 0) return;
  spec.interests = spec.interests.filter((name) => {
    if (clocked.some((item) => sameVisit(item, name))) return false;
    if (GENERIC_VISIT.test(name) || GENERIC_VISIT.test(canonicalVisitName(name))) return false;
    return true;
  });
}

/** A climb clock the brief named beside the sight. A departure clock does not count. */
function statedVisitClock(brief: string, title: string): string | null {
  const clocks = clocksIn(brief).filter((hit) => !hit.arrival);
  if (clocks.length === 0) return null;
  const blockers = [...brief.matchAll(/高铁|动车|飞机|航班|出发|返程|返回|回来|体检|开会|会议|面试/g)]
    .map((match) => match.index ?? -1)
    .filter((index) => index >= 0);
  for (const mention of visitMentions(brief)) {
    if (!sameVisit(mention.name, title)) continue;
    return nearestClock(clocks, mention.index, brief, blockers)?.time ?? null;
  }
  return null;
}

function applySpokenSchedule(spec: DraftSpec, now: Date): void {
  applyArrivalClock(spec, now);
  applyClockedVisits(spec, now);
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

const ERRAND_TITLE = /体检|开会|会议|面试|出差|看病|复诊/;
const GENERIC_VISIT = /^(爬山|登山|徒步|逛逛|走走|散步|旅游|旅行|游玩)$/;

export function canonicalVisitName(title: string): string {
  const hit = citiesInText(title)[0];
  if (hit) return hit.landmark;
  return title.trim();
}

function sameVisit(a: string, b: string): boolean {
  return canonicalVisitName(a) === canonicalVisitName(b);
}

export function normalizeVisitNames(names: string[]): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const name = canonicalVisitName(raw).slice(0, 24);
    if (!name || out.some((item) => sameVisit(item, name))) continue;
    out.push(name);
  }
  const specific = out.filter((name) => !GENERIC_VISIT.test(name));
  return (specific.length > 0 ? specific : out).slice(0, 8);
}

function keepsFixedSlot(item: { time: string | null; title: string; type: string }): boolean {
  return item.type === "办事" || ERRAND_TITLE.test(item.title) || Boolean(item.time);
}

function isVisitTitle(item: { title: string; type: string }): boolean {
  if (item.type === "景点") return true;
  if (citiesInText(item.title).length > 0) return true;
  return /爬山|登山|逛逛|徒步/.test(item.title) || /^(爬|登)/.test(item.title);
}

/** fixed keeps errands and clocked appointments. Unclocked sights become interests. */
export function foldUnclockedVisits<T extends { title: string; time: string | null; type: string }>(
  fixed: T[],
  interests: string[],
): { fixed: T[]; interests: string[] } {
  const kept: T[] = [];
  const extra: string[] = [];
  for (const item of fixed) {
    if (keepsFixedSlot(item)) {
      kept.push(item);
      continue;
    }
    if (isVisitTitle(item)) extra.push(item.title);
  }
  const keptNames = kept.map((item) => canonicalVisitName(item.title));
  const names = normalizeVisitNames([...interests, ...extra]).filter(
    (name) => !keptNames.some((fixedName) => fixedName === canonicalVisitName(name)),
  );
  return { fixed: kept, interests: names };
}

function adoptLandmarkCity(spec: DraftSpec, rawCity: string | null): void {
  if (!rawCity || spec.city === "未写明的目的地" || cityByName(rawCity)) return;
  const hit = citiesInText(rawCity)[0];
  if (!hit || hit.city === rawCity) return;
  spec.city = hit.city;
  spec.cityInferred = true;
  spec.landmark = hit.landmark;
  spec.interests = normalizeVisitNames([hit.landmark, ...spec.interests]);
}

function absorbCityLandmarks(spec: DraftSpec): void {
  if (spec.city === "未写明的目的地") return;
  const fromBrief = citiesInText(spec.brief)
    .filter((hit) => hit.city === spec.city)
    .map((hit) => hit.landmark);
  const kept = new Set(spec.fixed.map((item) => canonicalVisitName(item.title)));
  spec.interests = normalizeVisitNames([...(spec.landmark ? [spec.landmark] : []), ...fromBrief, ...spec.interests]).filter(
    (name) => !kept.has(canonicalVisitName(name)),
  );
  if (spec.landmark && kept.has(canonicalVisitName(spec.landmark))) spec.landmark = spec.interests[0] ?? null;
  if (!spec.landmark && spec.interests[0]) spec.landmark = spec.interests[0];
}

function coerceLeisureKind(spec: DraftSpec): void {
  const errand =
    ERRAND_TITLE.test(spec.brief) || spec.fixed.some((item) => item.type === "办事" || ERRAND_TITLE.test(item.title));
  if (!errand && spec.kind !== "旅游") spec.kind = "旅游";
}

function visitPlaced(items: RoadbookItem[], title: string): boolean {
  const key = canonicalVisitName(title);
  return items.some((item) => item.type === "景点" && canonicalVisitName(item.title) === key);
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
  const parsed = parseBrief(brief);
  const start = extract.startDate;
  let end = extract.endDate;
  let inbound = extract.inbound ? { ...extract.inbound } : null;
  if (guessedSameDayEnd(brief, start, end, parsed)) {
    end = null;
    // A copied same-day return date would still pin the leg to day 1 after the span falls back to 3.
    if (inbound?.date && start && inbound.date === start) inbound = { ...inbound, date: null };
  }
  const modelSpan = start && end && end >= start ? daysBetween(start, end) + 1 : null;
  if (modelSpan != null && modelSpan >= 1 && modelSpan <= 7) {
    spec.days = modelSpan;
    spec.daysAssumed = false;
    spec.startDate = start;
    spec.whenLabel = end === start ? start : `${start} 至 ${end}`;
  } else if (!parsed.daysAssumed) {
    spec.days = parsed.days;
    spec.daysAssumed = false;
    if (start) {
      spec.startDate = start;
      spec.whenLabel = start;
    }
  } else if (start) {
    spec.startDate = start;
    spec.whenLabel = start;
    spec.days = 3;
    spec.daysAssumed = true;
  }
  const party = partyFromCount(extract.party ?? statedPartyCount(brief));
  spec.partySummary = party.summary;
  spec.partyInferred = party.inferred;
  spec.interests = extract.interests.slice(0, 8);
  spec.landmark = spec.interests[0] ?? null;
  spec.pace = extract.pace;
  spec.paceInferred = !extract.pace;
  spec.slow = Boolean(extract.pace && /松|慢/.test(extract.pace));
  spec.outbound = extract.outbound ? { ...extract.outbound } : null;
  spec.inbound = inbound;
  spec.fixed = extract.fixed.map((item) => ({ ...item }));
  spec.lodging = extract.lodging ? { ...extract.lodging } : null;
  spec.cityInferred = false;
  if (!extract.destination.city || (spec.ask && spec.city === "未写明的目的地")) {
    spec.city = "未写明的目的地";
    spec.cityInferred = true;
    spec.ask = spec.ask ?? "去哪座城市？";
  }
  spec.whenInferred = !spec.startDate && !spec.whenLabel;
  if (!spec.ask) {
    adoptLandmarkCity(spec, extract.destination.city);
    const folded = foldUnclockedVisits(spec.fixed, spec.interests);
    spec.fixed = folded.fixed;
    spec.interests = folded.interests;
    absorbCityLandmarks(spec);
    coerceLeisureKind(spec);
    applyBriefFacts(spec, _now);
    ensureModelOutbound(spec, _now);
  }
  return spec;
}

/**
 * Rules drafts call attachTransport. The model path used to keep a missing outbound,
 * or a meeting clock written onto that leg, so day 1 had no hop.
 * Fill only a missing leg. A clock already beside 出发 or a ride word is left alone.
 */
function ensureModelOutbound(spec: DraftSpec, now: Date): void {
  const origin = spec.origin;
  const city = spec.city;
  if (!origin || city === "未写明的目的地" || city === origin) return;
  const text = spec.brief;
  const clocks = clocksIn(text).filter((hit) => !hit.arrival && !hit.rangeEnd);
  const goAt = text.search(/高铁|动车|飞机|航班|火车|出发|去往|前往/);
  const backAt = returnWordIndex(text);
  const goTime = goAt >= 0 ? nearestClock(clocks, goAt, text, backAt >= 0 ? [backAt] : [])?.time ?? null : null;
  const goDate = goAt >= 0 ? dateNear(text, goAt, shanghaiDate(now), now) : null;
  const meetingTimes = new Set(
    spec.fixed
      .filter((item) => item.type === "办事" || /开会|会议|体检|面试/.test(item.title))
      .map((item) => item.time)
      .filter((time): time is string => Boolean(time)),
  );
  const stolen = Boolean(spec.outbound?.time && spec.outbound.time !== goTime && meetingTimes.has(spec.outbound.time));
  if (spec.outbound && !stolen) return;
  const previous = spec.outbound;
  spec.outbound = {
    date: goDate ?? spec.startDate ?? previous?.date ?? null,
    time: goTime,
    arriveTime: previous?.arriveTime ?? null,
    mode: previous?.mode ?? modeOf(text),
    from: previous?.from ?? origin,
    to: previous?.to ?? city,
  };
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
      withReturn: wantsInferredReturn({ brief: spec.brief, origin: spec.origin, city: spec.city, days: spec.days }),
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

/** City centers. Straight-line distance is only a proxy for HSR ride time. */
const CITY_COORD: Record<string, [number, number]> = {
  上海: [31.23, 121.47],
  苏州: [31.3, 120.59],
  杭州: [30.27, 120.16],
  嘉兴: [30.75, 120.76],
  南京: [32.06, 118.8],
  无锡: [31.49, 120.31],
  宁波: [29.87, 121.54],
  合肥: [31.82, 117.23],
  济南: [36.65, 117.12],
  泰安: [36.19, 117.09],
  青岛: [36.07, 120.38],
  北京: [39.9, 116.41],
  天津: [39.34, 117.36],
  石家庄: [38.04, 114.51],
  郑州: [34.75, 113.63],
  武汉: [30.59, 114.31],
  长沙: [28.23, 112.94],
  广州: [23.13, 113.26],
  深圳: [22.54, 114.06],
  成都: [30.57, 104.07],
  重庆: [29.56, 106.55],
  西安: [34.34, 108.94],
  厦门: [24.48, 118.09],
  福州: [26.07, 119.3],
};

function haversineKm(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const lat1 = a[0] * rad;
  const lat2 = b[0] * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function coordCity(raw: string): string {
  const stripped = raw.trim().replace(/市$/u, "");
  return resolvePlaceToken(stripped) ?? stripped;
}

/** Cities that must not be turned into a domestic rail hop, even if coordinates are added later. */
const ABROAD = new Set(["东京", "京都", "大阪", "香港", "澳门", "台北", "新加坡", "首尔", "曼谷", "巴黎", "伦敦"]);
const FLIGHT_DEFAULT = 300;
const RETURN_LIMIT = 23 * 60 + 30;
const DEFAULT_RETURN = 18 * 60;
const BREAKFAST_EARLIEST = 7 * 60;
const BREAKFAST_LATEST = 10 * 60;

function abroadCity(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return ABROAD.has(coordCity(raw));
}

/** Short HSR hops are much less than 3 hours. Longer pairs stay above the old flat 180. */
function hsrMinutes(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  if (abroadCity(from) || abroadCity(to)) return null;
  const start = CITY_COORD[coordCity(from)];
  const end = CITY_COORD[coordCity(to)];
  if (!start || !end) return null;
  const km = haversineKm(start, end);
  const minutes = km < 150 ? 20 + km * 0.28 : 30 + (km / 220) * 60;
  return Math.max(25, Math.min(12 * 60, Math.round(minutes / 5) * 5));
}

/** Missing coordinates, or a trip that should default to a plane instead of a two-hour hop. */
function longHaulPair(from?: string | null, to?: string | null): boolean {
  if (!from || !to) return false;
  const start = coordCity(from);
  const end = coordCity(to);
  if (!start || !end || start === end) return false;
  if (abroadCity(start) || abroadCity(end)) return true;
  return !CITY_COORD[start] || !CITY_COORD[end];
}

function modeMinutes(mode: DraftLeg["mode"], from?: string | null, to?: string | null): number {
  const long = longHaulPair(from, to);
  if (mode === "自驾") return 240;
  if (mode === "飞机") return long ? FLIGHT_DEFAULT : 150;
  if (long) return FLIGHT_DEFAULT;
  const ride = hsrMinutes(from ?? null, to ?? null);
  if (mode === "高铁") return ride ?? 240;
  // Empty mode and 「其他」 share the city-pair estimate. Do not flatten to 120 when the coordinates are known.
  if ((mode == null || mode === "其他") && ride != null) return ride;
  return 120;
}

/** Minutes after locked blocks, plus the hour needed to reach the station. */
export function returnEarliestMinute(locked: { startTime: string; durationMinutes: number }[]): number {
  let earliest = 0;
  for (const entry of locked) {
    const start = parseTime(entry.startTime);
    if (start == null) continue;
    const ready = start + entry.durationMinutes + 60;
    if (ready > earliest) earliest = ready;
  }
  return earliest;
}

/** Latest inferred return that still finishes by 23:30, rounded down to the half hour. */
export function fitInferredReturn(ride: number, earliest: number): { start: number; overflow: boolean } {
  const latestFit = RETURN_LIMIT - ride;
  const ideal = Math.floor(Math.min(DEFAULT_RETURN, latestFit) / 30) * 30;
  if (ideal >= earliest && ideal + ride <= RETURN_LIMIT) return { start: ideal, overflow: false };
  const bumped = Math.ceil(Math.max(earliest, 0) / 30) * 30;
  if (bumped + ride <= RETURN_LIMIT) return { start: bumped, overflow: false };
  const fallback = DEFAULT_RETURN >= earliest ? DEFAULT_RETURN : bumped;
  return { start: fallback, overflow: fallback + ride > RETURN_LIMIT };
}

function withOverflow(note: string, start: number, ride: number): string {
  return noteForPlacedClock(note, formatTime(start), ride) ?? note;
}

function earliestReturnStart(items: RoadbookItem[], day: number): number {
  return returnEarliestMinute(
    items.filter((entry) => entry.dayIndex === day && entry.locked && entry.type !== "交通"),
  );
}

function isBreakfastTitle(title: string): boolean {
  return /早餐|早饭/.test(title) || /早上/.test(title);
}

function dropMisplacedBreakfast(items: RoadbookItem[]): RoadbookItem[] {
  return items.filter((entry) => {
    if (entry.type !== "餐" || !isBreakfastTitle(entry.title)) return true;
    const start = parseTime(entry.startTime);
    if (start == null) return true;
    if (start > BREAKFAST_LATEST) return false;
    const climb = items.find((other) => other.dayIndex === entry.dayIndex && other.type === "景点" && isClimbTitle(other.title));
    if (climb) {
      const climbStart = parseTime(climb.startTime);
      if (climbStart != null && start >= climbStart) return false;
    }
    const ride = items.find(
      (other) => other.dayIndex === entry.dayIndex && other.type === "交通" && other.title.includes("前往") && !other.title.startsWith("返回"),
    );
    if (ride) {
      const depart = parseTime(ride.startTime);
      if (depart != null && depart < BREAKFAST_EARLIEST && start >= depart) {
        const arrived = depart + ride.durationMinutes;
        const climbAt = climb ? parseTime(climb.startTime) : null;
        const beforeClimb = climbAt == null || start < climbAt;
        if (start >= arrived && start <= BREAKFAST_LATEST && beforeClimb) return true;
        return false;
      }
    }
    return true;
  });
}

function presentItems(items: RoadbookItem[]): RoadbookItem[] {
  return dropMisplacedBreakfast(items.filter((entry) => !selfTrip(entry.title))).map((entry) => {
    if (!entry.note) return entry;
    const note = noteForPlacedClock(entry.note, entry.startTime);
    if (note === entry.note) return entry;
    return { ...entry, note: note || undefined };
  });
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
  return { kind: "实测", note: "来自你的原话" };
}

function isClimbTitle(title: string): boolean {
  const name = canonicalVisitName(title);
  if (GENERIC_VISIT.test(name) || GENERIC_VISIT.test(title)) return false;
  return CLIMB_RE.test(name) || CLIMB_RE.test(title);
}

function fixedSpan(fixed: DraftFixed): number {
  if (fixed.time && fixed.endTime) {
    const start = parseTime(fixed.time);
    const end = parseTime(fixed.endTime);
    if (start != null && end != null && end > start) return Math.min(600, Math.max(30, end - start));
  }
  if (fixed.type === "办事" || ERRAND_TITLE.test(fixed.title)) return 120;
  if ((fixed.type === "景点" || isVisitTitle(fixed)) && isClimbTitle(fixed.title)) return CLIMB_MINUTES;
  return 90;
}

function namedInterest(place: Place, spec: DraftSpec): boolean {
  const names = [...spec.interests];
  if (spec.landmark) names.push(spec.landmark);
  return names.some((name) => {
    const key = canonicalVisitName(name);
    if (!key) return false;
    return place.name === key || place.name.includes(key) || key.includes(place.name);
  });
}

/** Named sights keep the must-visit note. A missing city guide must not relabel them as a generic template. */
function describeSight(place: Place, spec: DraftSpec, unknown: boolean): { note: string; source: RoadbookItem["source"] } {
  const named = namedInterest(place, spec);
  if (named && (unknown || place.detail.includes("你点名要去的地方"))) {
    const note = place.detail.includes("你点名要去的地方") ? place.detail : `你点名要去的地方。${place.detail}`;
    return { note, source: inferredSource("本地草稿") };
  }
  if (unknown) {
    return {
      note: "通用模板，地点是推断，不是别的城市的景点。",
      source: inferredSource("通用模板，地点是推断"),
    };
  }
  return { note: place.detail, source: inferredSource("本地草稿") };
}

function linkedInbound(spec: DraftSpec): boolean {
  if (!spec.inbound) return false;
  const from = spec.inbound.from ?? (spec.city === "未写明的目的地" ? null : spec.city);
  const to = spec.inbound.to ?? spec.origin;
  return Boolean(from && to && from !== to);
}

/**
 * The legacy template already draws its own return. Anchored drafts need the leg on the spec
 * so the last evening stays a cutoff. A stated return clock is left untouched.
 */
function inferReturnIfAnchored(spec: DraftSpec): DraftSpec {
  if (!wantsInferredReturn({ brief: spec.brief, origin: spec.origin, city: spec.city, days: spec.days })) return spec;
  if (useLegacy(spec)) return spec;
  const mode = spec.inbound?.mode ?? spec.outbound?.mode ?? null;
  if (linkedInbound(spec) && spec.inbound) {
    return {
      ...spec,
      inbound: {
        ...spec.inbound,
        time: null,
        mode,
        from: spec.inbound.from ?? spec.city,
        to: spec.inbound.to ?? spec.origin,
      },
    };
  }
  return {
    ...spec,
    inbound: {
      date: spec.startDate ? addDays(spec.startDate, spec.days - 1) : null,
      time: null,
      mode,
      from: spec.city,
      to: spec.origin,
    },
  };
}

function anchoredItems(spec: DraftSpec, random: () => string, now: Date): RoadbookItem[] {
  const days = spec.days;
  const start = spec.startDate ?? shanghaiDate(now);
  const label = spec.city === "未写明的目的地" ? "待定" : spec.city;
  const items: RoadbookItem[] = [];
  const outboundMark: { day: number; end: number }[] = [];
  const inboundMark: { day: number; start: number }[] = [];

  const pushLeg = (
    leg: DraftLeg,
    day: number,
    title: string,
    place: string,
    endpoints: { from: string | null; to: string | null },
    statedTime = Boolean(leg.time),
    keepFull = false,
  ) => {
    if (selfTrip(title)) return;
    const time = leg.time ?? "08:00";
    const ride = modeMinutes(leg.mode, endpoints.from, endpoints.to);
    const startMin = parseTime(time) ?? DAY_START;
    let duration = keepFull ? ride : clampDuration(time, ride);
    let arriveNote = "";
    if (leg === spec.outbound && leg.time && leg.arriveTime) {
      const arrive = parseTime(leg.arriveTime);
      if (arrive != null && arrive > startMin) {
        duration = clampDuration(time, Math.max(ride, arrive - startMin));
        arriveNote = `到达 ${leg.arriveTime}。`;
      }
    }
    const baseNote = statedTime
      ? `来自你的原话。${arriveNote}时长是估计，班次和到达时间请自己查。路书不代订。`
      : "时间推断。原话没写钟点，先放在这个时间。时长是估计，班次请自己查。路书不代订。";
    items.push(
      item(random, {
        dayIndex: day,
        startTime: time,
        durationMinutes: duration,
        title,
        place,
        type: "交通",
        status: "待做",
        travelEstimateMinutes: ride,
        estimateSource: "推断",
        locked: statedTime,
        priority: "必去",
        indoor: true,
        note: keepFull ? withOverflow(baseNote, startMin, ride) : baseNote,
        source: statedTime ? statedSource() : inferredSource("时间推断"),
      }),
    );
    if (leg === spec.outbound) outboundMark.push({ day, end: startMin + duration });
    else inboundMark.push({ day, start: startMin });
  };

  if (spec.outbound) {
    const from = spec.outbound.from ?? spec.origin;
    const to = spec.outbound.to ?? (spec.city === "未写明的目的地" ? null : spec.city);
    const day = dayIndexFor(spec.outbound.date, start, days);
    const arriveOnly = Boolean(spec.outbound.arriveTime) && !spec.outbound.time;
    if (arriveOnly && to) {
      const time = spec.outbound.arriveTime ?? "12:00";
      const title = from && from !== to ? `从${from}到达${to}` : `到达${to}`;
      if (!selfTrip(title)) {
        const duration = 30;
        items.push(
          item(random, {
            dayIndex: day,
            startTime: time,
            durationMinutes: duration,
            title,
            place: from ?? to,
            type: "交通",
            status: "待做",
            travelEstimateMinutes: duration,
            estimateSource: "推断",
            locked: true,
            priority: "必去",
            indoor: true,
            note: "来自你的原话。这是到达时间。班次请自己查。路书不代订。",
            source: statedSource(),
          }),
        );
        const startMin = parseTime(time) ?? DAY_START;
        outboundMark.push({ day, end: startMin + duration });
      }
    } else if (from && to && from !== to) {
      pushLeg(spec.outbound, day, `从${from}前往${to}`, from, { from, to });
      if (spec.outbound.arriveTime) {
        const arrive = parseTime(spec.outbound.arriveTime);
        const mark = outboundMark.find((entry) => entry.day === day);
        if (mark && arrive != null) mark.end = Math.max(mark.end, arrive);
      }
    }
  }
  const pendingReturn: { day: number; from: string; to: string; mode: DraftLeg["mode"] }[] = [];
  const placeStation = (day: number, depart: number) => {
    const buffer = depart - 60;
    if (buffer < DAY_START || overlaps(buffer, 60, items, day)) return;
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
  };
  if (spec.inbound) {
    const from = spec.inbound.from ?? (spec.city === "未写明的目的地" ? null : spec.city);
    const to = spec.inbound.to ?? spec.origin;
    if (from && to && from !== to) {
      const day = dayIndexFor(spec.inbound.date ?? (spec.startDate ? addDays(spec.startDate, days - 1) : null), start, days);
      const statedClock = statedReturnClock(spec.brief);
      const stated = Boolean(statedClock && spec.inbound.time === statedClock);
      if (stated) {
        const time = spec.inbound.time ?? statedClock ?? "18:00";
        pushLeg({ ...spec.inbound, time }, day, `从${from}前往${to}`, from, { from, to }, true, true);
        const depart = parseTime(time);
        if (depart != null) placeStation(day, depart);
      } else {
        pendingReturn.push({ day, from, to, mode: spec.inbound.mode ?? spec.outbound?.mode ?? null });
      }
    }
  }

  for (const fixed of spec.fixed) {
    const day = dayIndexFor(fixed.date, start, days);
    const wanted = fixedSpan(fixed);
    const depart = inboundMark.find((mark) => mark.day === day)?.start ?? DAY_LIMIT;
    const windowEnd = Math.min(DAY_LIMIT, depart);
    const clockStated = Boolean(fixed.time);
    const stated = clockStated && fixed.time ? parseTime(fixed.time) : null;
    const searchFrom = stated != null && stated >= EARLY_FLOOR && stated < DAY_START ? stated : DAY_START;
    const spanAt = (startMin: number) => Math.max(0, Math.min(wanted, windowEnd - startMin));
    const fits = (startMin: number) => {
      const span = spanAt(startMin);
      if (startMin < EARLY_FLOOR || span < 30) return false;
      if (isClimbTitle(fixed.title) && span < Math.min(wanted, 300)) return false;
      return !overlaps(startMin, span, items, day);
    };
    let startMin: number | null = stated != null && fits(stated) ? stated : null;
    if (startMin == null) {
      const probes = isClimbTitle(fixed.title) ? [wanted, 360, 300] : [Math.min(wanted, 150)];
      const preferred = stated != null && stated < windowEnd ? Math.max(stated, searchFrom) : DAY_START;
      for (const probe of probes) {
        startMin = placeFree(items, day, searchFrom, windowEnd, preferred, probe);
        if (startMin != null) break;
      }
    }
    if (startMin == null) continue;
    const placedClock = formatTime(startMin);
    const span = Math.max(30, spanAt(startMin));
    const honored = stated != null && startMin === stated && fits(stated);
    const clockNote = honored
      ? "来自你的原话。"
      : clockStated
        ? `时间推断。先放在 ${placedClock}。`
        : `时间推断。钟点没写，先放在 ${placedClock}。`;
    items.push(
      item(random, {
        dayIndex: day,
        startTime: placedClock,
        durationMinutes: clampDuration(placedClock, span),
        title: fixed.title,
        place: fixed.place ? `${label} · ${fixed.place}` : `${label} · ${spec.area ?? "附近"}`,
        type: fixed.type,
        status: "待做",
        travelEstimateMinutes: 15,
        estimateSource: "推断",
        locked: honored,
        priority: "必去",
        indoor: fixed.type === "景点" && isClimbTitle(fixed.title) ? false : true,
        note: clockNote,
        source: honored ? statedSource() : inferredSource("时间推断"),
      }),
    );
  }

  const squeezed: string[] = [];
  for (const pending of pendingReturn) {
    const ride = modeMinutes(pending.mode, pending.from, pending.to);
    const fit = fitInferredReturn(ride, earliestReturnStart(items, pending.day));
    const rideItem = inferredReturnItem(
      random,
      pending.day,
      pending.to,
      pending.from,
      pending.mode,
      returnEstimateNote(spec.brief),
      formatTime(fit.start),
      ride,
    );
    items.push(rideItem);
    inboundMark.push({ day: pending.day, start: fit.start });
    placeStation(pending.day, fit.start);
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
      if (startMin == null) {
        const back = returning?.start;
        if (back != null && back < DEFAULT_RETURN) {
          const oldLatest = DEFAULT_RETURN - 60;
          if (preferred + duration <= oldLatest && preferred + duration > latest && !squeezed.includes(fields.title)) {
            squeezed.push(fields.title);
          }
        }
        return false;
      }
      const title = fields.title;
      if (selfTrip(title)) return false;
      const placed = formatTime(startMin);
      items.push(
        item(random, {
          ...fields,
          dayIndex: day,
          startTime: placed,
          durationMinutes: duration,
          note: fields.note ? noteForPlacedClock(fields.note, placed) : fields.note,
        }),
      );
      return true;
    };
    if (spec.kind === "旅游") {
      if (earliest > 16 * 60) {
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
        continue;
      }
      let placedToday = 0;
      const sightFields = (place: Place, interest: boolean) => {
        const copy = describeSight(place, spec, unknown);
        return {
          dayIndex: day,
          startTime: "10:00",
          durationMinutes: 100,
          title: place.name,
          place: `${label} · ${place.area}`,
          type: "景点" as const,
          status: "待做" as const,
          travelEstimateMinutes: 20,
          locked: false,
          priority: interest ? ("必去" as const) : sightPriority(place, spec.landmark),
          indoor: place.indoor,
          note: copy.note,
          source: copy.source,
        };
      };
      const outbound = items.find(
        (entry) => entry.dayIndex === day && entry.type === "交通" && entry.title.includes("前往") && !entry.title.startsWith("返回"),
      );
      const depart = outbound ? parseTime(outbound.startTime) : null;
      const climbItem = items.find((entry) => entry.dayIndex === day && entry.type === "景点" && isClimbTitle(entry.title));
      const statedClimb = climbItem ? statedVisitClock(spec.brief, climbItem.title) : null;
      const mustName = spec.interests[0] ?? spec.landmark;
      const allowRepeat = repeatRequested(spec.brief);
      const deferFull = (place: Place) => earliest > 11 * 60 && isFullDay(place) && day < days;
      for (const place of pool) {
        if (visitPlaced(items, place.name)) used.set(place.name, Math.max(used.get(place.name) ?? 0, 1));
      }
      const takePlaced = (defer: boolean): Place | null => {
        const place = peekSight(pool, used, mustName, allowRepeat, (candidate) => {
          if (defer && deferFull(candidate)) return true;
          if (
            GENERIC_VISIT.test(candidate.name) &&
            items.some((entry) => entry.type === "景点" && isClimbTitle(entry.title))
          ) {
            return true;
          }
          return false;
        });
        if (!place || visitPlaced(items, place.name)) return null;
        return place;
      };
      const upcoming = climbItem ? null : takePlaced(true);
      const climbMorning = Boolean(climbItem) || Boolean(upcoming && isClimbTitle(upcoming.name));
      const earlyBreakfastAt = earliest <= BREAKFAST_LATEST ? alignTen(Math.max(earliest, BREAKFAST_EARLIEST)) : null;
      if (
        climbItem &&
        !statedClimb &&
        !climbItem.locked &&
        earlyBreakfastAt != null &&
        earlyBreakfastAt + 70 <= latest
      ) {
        const climbAt = earlyBreakfastAt + 40;
        const room = latest - climbAt;
        const span = Math.min(climbItem.durationMinutes, room);
        const blocked = items.some((entry) => {
          if (entry === climbItem || entry.dayIndex !== day) return false;
          const other = parseTime(entry.startTime);
          if (other == null) return false;
          return climbAt < other + entry.durationMinutes && climbAt + span > other;
        });
        if (!blocked && room >= 30 && climbAt >= earliest) {
          climbItem.startTime = formatTime(climbAt);
          if (climbItem.durationMinutes > room) climbItem.durationMinutes = room;
          const rewritten = noteForPlacedClock(climbItem.note, climbItem.startTime);
          if (rewritten) climbItem.note = rewritten;
        }
      }
      const climbAlready = Boolean(climbItem);
      const climbStart = climbItem ? parseTime(climbItem.startTime) : null;
      const breakfastFields = (placeLabel: string) => ({
        dayIndex: day,
        startTime: "09:00",
        durationMinutes: 40,
        title: guide.food[0] ?? "早餐",
        place: placeLabel,
        type: "餐" as const,
        status: "待做" as const,
        travelEstimateMinutes: 10,
        locked: false,
        priority: "想去" as const,
        indoor: true,
        source: inferredSource(unknown ? "通用模板，地点是推断" : "本地草稿"),
      });
      const breakfastPreferred = climbMorning && earlyBreakfastAt != null ? earlyBreakfastAt : 9 * 60;
      let ate = false;
      if (earliest <= BREAKFAST_LATEST && (climbStart == null || earliest < climbStart)) {
        const cap = climbStart != null ? Math.min(latest, climbStart) : latest;
        const slot = placeFree(items, day, Math.max(earliest, BREAKFAST_EARLIEST), cap, breakfastPreferred, 40);
        if (slot != null && slot <= BREAKFAST_LATEST && (climbStart == null || slot + 40 <= climbStart)) {
          ate = addAt(slot, 40, breakfastFields(mealPlace));
        }
      }
      if (!ate && climbAlready && depart != null && spec.origin && depart - BREAKFAST_EARLIEST >= 40) {
        const slot = placeFree(items, day, BREAKFAST_EARLIEST, depart, Math.min(8 * 60, depart - 40), 40);
        if (slot != null && slot <= BREAKFAST_LATEST && slot + 40 <= depart) {
          items.push(
            item(random, {
              ...breakfastFields(spec.origin),
              startTime: formatTime(slot),
              durationMinutes: 40,
            }),
          );
          ate = true;
        }
      }
      if (!climbAlready && placedToday < 2 && latest - earliest >= 90) {
        const first = upcoming ?? takePlaced(true);
        if (first) {
          const interest = spec.interests.some((name) => first.name.includes(name) || name.includes(first.name));
          const duration = isFullDay(first) ? Math.min(360, latest - earliest - 30) : 100;
          const breakfastPlaced = items.find(
            (entry) => entry.dayIndex === day && entry.type === "餐" && isBreakfastTitle(entry.title),
          );
          const afterBreakfast = breakfastPlaced
            ? (parseTime(breakfastPlaced.startTime) ?? 0) + breakfastPlaced.durationMinutes
            : null;
          const preferred =
            isClimbTitle(first.name) && afterBreakfast != null ? afterBreakfast : Math.max(earliest, 10 * 60);
          if (addAt(preferred, duration, sightFields(first, interest))) {
            commitSight(used, first);
            placedToday += 1;
            if (isFullDay(first)) placedToday = 2;
          }
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
      if (!climbAlready && placedToday < 2 && latest - earliest >= 90) {
        const second = takePlaced(true);
        if (second) {
          const interest = spec.interests.some((name) => second.name.includes(name) || name.includes(second.name));
          if (addAt(Math.max(earliest, 14 * 60), 100, sightFields(second, interest))) {
            commitSight(used, second);
            placedToday += 1;
          }
        } else if (placedToday < 2 && !pool.some((place) => (used.get(place.name) ?? 0) === 0 && !deferFull(place))) {
          const held = pool.some((place) => (used.get(place.name) ?? 0) === 0 && deferFull(place));
          if (!(placedToday === 0 && held) && !items.some((entry) => entry.dayIndex === day && entry.title === "自由活动")) {
            addAt(Math.max(earliest, placedToday === 0 ? 10 * 60 : 14 * 60), 100, {
              dayIndex: day,
              startTime: "10:00",
              durationMinutes: 100,
              title: "自由活动",
              place: mealPlace,
              type: "自由",
              status: "待做",
              travelEstimateMinutes: 10,
              locked: false,
              priority: "可砍",
              indoor: false,
              note: "这一天没有新的景点了，自己安排。赶时间可以拿掉。",
            });
          }
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
        if (place && !visitPlaced(items, place.name)) {
          const interest = spec.interests.some((name) => place.name.includes(name) || name.includes(place.name));
          const copy = describeSight(place, spec, unknown);
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
              note: copy.note,
              source: copy.source,
            })
          ) {
            sights += 1;
          }
        }
      }
    }
  }
  if (squeezed.length > 0) {
    const back = [...items].reverse().find((entry) => entry.type === "交通" && entry.title.startsWith("返回"));
    if (back) {
      const sentence = `${back.startTime} 之后的安排放不下，已拿掉${squeezed.join("、")}。`;
      back.note = `${back.note ?? ""}${back.note?.endsWith("。") ? "" : "。"}${sentence}`;
    }
  }
  return presentItems(items);
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
  const scheduled = inferReturnIfAnchored({ ...ready, startDate: resolvedStart });
  const items = (
    ready.ask ? [] : useLegacy(ready) ? legacyItems(ready, random) : anchoredItems(scheduled, random, now)
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
  const inferredBack = items.find((entry) => entry.type === "交通" && entry.title.startsWith("返回") && !entry.locked);
  const squeezedNote = inferredBack?.note?.match(/\d{2}:\d{2} 之后的安排放不下，已拿掉[^。]*。/)?.[0];
  if (wantsInferredReturn({ brief: ready.brief, origin: ready.origin, city: ready.city, days: ready.days })) {
    const baseNote = returnEstimateNote(ready.brief);
    const detail = squeezedNote ? `${baseNote}${baseNote.endsWith("。") ? "" : "。"}${squeezedNote}` : baseNote;
    assumptions.push(
      assumption(random, {
        key: "return",
        label: "返程",
        value: returnAssumptionValue(ready.brief, ready.days, inferredBack?.startTime ?? "18:00"),
        inferred: true,
        detail,
      }),
    );
  }
  const createdAt = now.toISOString();
  const question = ready.ask
    ? { id: "city", prompt: ready.ask }
    : city === "未写明的目的地"
      ? { id: "city", prompt: "去哪座城市？" }
      : null;
  const inferredLabels = assumptions.filter((item) => item.inferred).map((item) => item.label);
  const drafted = inferredLabels.length > 0 ? `草稿已出 · 推断了${inferredLabels.join("、")}` : "草稿已出";
  const statusLine = question
    ? items.length === 0
      ? "先确认去哪座城市，再排行程。"
      : "先出了骨架。只差一个城市，其余都标在假设上。"
    : squeezedNote
      ? `${drafted}。${squeezedNote}`
      : drafted;
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
    verifyChecklist: verifyLines(ready.ask || useLegacy(ready) ? ready : scheduled).map((text) => ({ id: `v_${random()}`, text })),
    patchHistory: [
      {
        id: `p_${random()}`,
        at: createdAt,
        label: "生成草稿",
        kind: "draft",
        ops: items.map((entry) => ({ op: "add" as const, item: { ...entry, source: { ...entry.source } } })),
      },
    ],
    undo: [],
    question,
    statusLine,
    ownerId: DEFAULT_OWNER_ID,
  };
}

export function buildDraft(brief: string, options: DraftOptions): Roadbook {
  const now = options.now ?? new Date();
  return buildDraftFromSpec(specFromRules(brief, now), { ...options, now });
}
