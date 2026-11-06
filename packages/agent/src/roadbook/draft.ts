import { guideFor, type Place } from "../cities";
import { citiesInText } from "@lushu/tools/place";
import { parseBrief } from "../parse";
import { inferStartDate } from "./time";
import type { Assumption, Roadbook, RoadbookItem } from "./types";

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
  if (options.origin && dayIndex === 1) {
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
  if (arriving && origin) {
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

export function buildDraft(brief: string, options: DraftOptions): Roadbook {
  const now = options.now ?? new Date();
  const random = rng(options.random);
  const text = brief.trim();
  const spec = parseBrief(text);
  const city = spec.destinations[0] ?? "未写明的目的地";
  const known = city !== "未写明的目的地" && text.includes(city);
  const landmark = citiesInText(text).find((hit) => hit.city === city)?.landmark ?? null;
  const cityInferred = !known && city !== "未写明的目的地";
  const withReturn = Boolean(spec.origin) && spec.days <= 3;
  const used = new Map<string, number>();
  const items = Array.from({ length: spec.days }, (_, index) =>
    itemsForDay(city, index + 1, spec.days, random, {
      origin: spec.origin,
      withReturn,
      mustVisit: landmark,
      used,
      allowRepeat: repeatRequested(text),
    }),
  ).flat();
  const assumptions: Assumption[] = [
    assumption(random, {
      key: "city",
      label: "目的地",
      value: city === "未写明的目的地" ? "待定" : city,
      inferred: cityInferred || city === "未写明的目的地",
      detail: cityInferred && landmark ? `由「${landmark}」推断为${city}` : city === "未写明的目的地" ? "句子里没有认出城市" : undefined,
    }),
    assumption(random, {
      key: "days",
      label: "天数",
      value: `${spec.days} 天`,
      inferred: spec.daysAssumed,
      detail: spec.daysAssumed ? "没写天数，先按这个写" : undefined,
    }),
    assumption(random, {
      key: "party",
      label: "人数",
      value: spec.party.summary,
      inferred: spec.party.kind === "unknown",
      detail: spec.party.kind === "unknown" ? "人数没写清" : undefined,
    }),
    assumption(random, {
      key: "when",
      label: "时间",
      value: spec.whenLabel ?? "日期未定",
      inferred: !spec.whenLabel,
    }),
    assumption(random, {
      key: "origin",
      label: "出发",
      value: spec.origin ?? "当地集合",
      inferred: !spec.origin,
    }),
    assumption(random, {
      key: "pace",
      label: "节奏",
      value: spec.themes.includes("slow") ? "松一点" : "正常步行",
      inferred: true,
      detail: "路程分钟数是推断，不是导航",
    }),
  ];
  const createdAt = now.toISOString();
  const question =
    city === "未写明的目的地"
      ? { id: "city", prompt: "这次主要去哪座城市？" }
      : null;
  const inferredLabels = assumptions.filter((item) => item.inferred).map((item) => item.label);
  const statusLine = question
    ? "先出了骨架。只差一个城市，其余都标在假设上。"
    : inferredLabels.length > 0
      ? `草稿已出 · 推断了${inferredLabels.join("、")}`
      : "草稿已出";
  return {
    id: options.id,
    createdAt,
    updatedAt: createdAt,
    brief: text,
    title: `${city === "未写明的目的地" ? "待定行程" : city} · ${spec.days} 天`,
    city,
    startDate: inferStartDate(spec.whenLabel, now),
    assumptions,
    items,
    weather: [],
    verifyChecklist: [
      { id: `v_${random()}`, text: "开放时间、闭馆日、要不要预约，出发前再核实" },
      { id: `v_${random()}`, text: "用餐只是建议。路书不代订、不收款" },
      { id: `v_${random()}`, text: "当天再看一眼天气" },
    ],
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
