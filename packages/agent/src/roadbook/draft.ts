import { guideFor } from "../cities";
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

export function itemsForDay(
  city: string,
  dayIndex: number,
  dayCount: number,
  random: () => string,
  options: { origin: string | null; withReturn?: boolean } ,
): RoadbookItem[] {
  const guide = guideFor(city === "未写明的目的地" ? "待定城市" : city);
  const outdoor = guide.places.filter((place) => !place.indoor && !place.evening);
  const first = outdoor[0];
  const second = outdoor[1];
  const placeName = city === "未写明的目的地" ? "待定" : city;
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
      title: first?.name ?? `${placeName}走走`,
      place: first ? `${placeName} · ${first.area}` : placeName,
      type: "景点",
      status: "待做",
      travelEstimateMinutes: 20,
      locked: false,
      priority: "必去",
      indoor: false,
      note: first?.detail,
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
        title: second?.name ?? "城区再走一段",
        place: second ? `${placeName} · ${second.area}` : placeName,
        type: "景点",
        status: "待做",
        travelEstimateMinutes: 20,
        locked: false,
        priority: "想去",
        indoor: second?.indoor ?? false,
        note: second?.detail,
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
  const items = Array.from({ length: spec.days }, (_, index) =>
    itemsForDay(city, index + 1, spec.days, random, { origin: spec.origin, withReturn }),
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
