import type { WeatherReport } from "@lushu/tools";
import { CONFIRMED_MARK } from "./clarify";
import { guideFor, type CityGuide, type Place, type PlaceCost } from "./cities";
import type { ItineraryDay, ItineraryItem, PlanVariant, Source, Theme, ToolBundle, TripSpec } from "./types";

export type DayStyle = "classic" | "food" | "family" | "rain" | "budget" | "business" | "slow" | "relaxed";

const COST_TEXT: Record<PlaceCost, string> = {
  free: "多半不用门票",
  low: "花费通常不高，以现场为准",
  mid: "可能需要门票，请出发前核实",
};

export function alternateStyle(themes: Theme[]): DayStyle {
  const order = ["food", "family", "rain", "budget", "business", "slow"] as const;
  for (const style of order) {
    if (themes.includes(style)) return style;
  }
  return "relaxed";
}

export function allocateCities(cities: string[], days: number): string[] {
  if (days <= 0) return [];
  if (cities.length === 0) return Array.from({ length: days }, () => "当地");
  if (cities.length === 1) return Array.from({ length: days }, () => cities[0] ?? "当地");
  const usable = cities.slice(0, days);
  const counts = usable.map(() => 1);
  let extra = days - usable.length;
  let index = usable.length - 1;
  while (extra > 0) {
    counts[index] = (counts[index] ?? 1) + 1;
    extra -= 1;
    index = (index - 1 + usable.length) % usable.length;
  }
  const out: string[] = [];
  usable.forEach((city, i) => {
    for (let n = 0; n < (counts[i] ?? 1); n += 1) out.push(city);
  });
  return out;
}

export function budgetNote(spec: TripSpec): string {
  const people = spec.party.count ?? 2;
  const days = spec.days;
  const food = spec.budgetTight ? 70 : 150;
  const transit = spec.budgetTight ? 15 : 40;
  const tickets = spec.budgetTight ? 20 : 70;
  const room = spec.budgetTight ? 120 : 280;
  const local = (food + transit + tickets) * people * days;
  const stay = room * days;
  const stated =
    spec.budgetAmountCny != null
      ? `你写到的预算大约是 ¥${spec.budgetAmountCny}${spec.budgetText ? `（原文：${spec.budgetText}）` : ""}。`
      : "需求里没有写明金额。";
  const fit =
    spec.budgetAmountCny == null
      ? ""
      : spec.budgetAmountCny >= local
        ? `对照不含住宿的市内花费约 ¥${local}，这个数字大体够用。`
        : `对照不含住宿的市内花费约 ¥${local}，这个数字偏紧，所以行程优先免费和低价。`;
  return [
    `预算说明（参考，不是报价；路书不收款，也不代订）：按${spec.party.summary}、${days} 天、${spec.budgetTight ? "节省" : "普通"}口径估算。`,
    stated,
    `餐饮约 ¥${food}/人/天，市内交通约 ¥${transit}/人/天，门票约 ¥${tickets}/人/天，市内合计约 ¥${local}。`,
    `住宿另计，按一间房 ¥${room}/晚粗算约 ¥${stay}，实际差很多，请自己查。`,
    fit,
    "往返大交通默认不含。",
  ]
    .filter(Boolean)
    .join("");
}

function earlyBird(spec: TripSpec): boolean {
  return /早上出门|避开整点|排队|春节|国庆|人多/.test(spec.rawBrief);
}

function rankPlaces(guide: CityGuide, spec: TripSpec, style: DayStyle): Place[] {
  return guide.places
    .map((place, index) => {
      let score = 0;
      if (place.keywords.some((keyword) => keyword && spec.rawBrief.includes(keyword))) score += 6;
      if (style === "rain" && place.indoor) score += 4;
      if (style === "family" && place.indoor) score += 2;
      if (style === "business" && place.evening) score += 4;
      if ((style === "budget" || spec.budgetTight) && place.cost === "free") score += 3;
      if ((style === "budget" || spec.budgetTight) && place.cost === "low") score += 1;
      if ((style === "budget" || spec.budgetTight) && place.cost === "mid") score -= 3;
      if ((style === "slow" || style === "relaxed" || style === "family") && place.fullDay) score -= 1;
      if (style === "food" && place.keywords.some((keyword) => /吃|美食|小吃|早茶/.test(keyword))) {
        score += 2;
      }
      return { place, score, index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.place);
}

function rainPlan(guide: CityGuide, emphasize: boolean): string {
  const indoor = guide.places.find((item) => item.indoor);
  const name = indoor?.name ?? "附近的博物馆或商场";
  if (emphasize) {
    return `雨天或风大时改为室内：${name}。户外步行缩短，闭馆和门票请出发前核实。`;
  }
  return `如果下雨或走不动，把户外换成室内的${name}，其余顺延。`;
}

function mealsFor(guide: CityGuide, dayIndex: number): string[] {
  const food = guide.food.length > 0 ? guide.food : ["当地早餐", "简单午餐", "晚饭早吃"];
  return [0, 1, 2].map((offset) => food[(dayIndex + offset) % food.length] ?? food[0] ?? "当地吃饭");
}

function stayNote(guide: CityGuide, spec: TripSpec): string {
  if (guide.name === "京都" && /町家/.test(spec.rawBrief)) {
    return "优先找町家或小旅馆，住在清水、祗园或京都站之间不用转两次车的位置。路书不代订，也不收款。";
  }
  return `${guide.stayNote}路书不代订住宿。`;
}

function item(time: string, place: Place, extra = ""): ItineraryItem {
  return {
    time,
    title: place.name,
    area: place.area,
    estCost: COST_TEXT[place.cost],
    detail: `${place.detail}${extra}`,
  };
}

function weatherAssumption(reports: WeatherReport[]): string {
  const live = reports.filter((report) => !report.stub && report.days.length > 0);
  if (live.length === 0) return "天气没有取到实况，出发前请再查预报。";
  return live
    .map((report) => {
      const preview = report.days
        .slice(0, 3)
        .map((day) => {
          const rain =
            day.precipProbability != null ? `，降雨概率约 ${day.precipProbability}%` : "";
          const temp =
            day.tempMinC != null && day.tempMaxC != null ? `，${day.tempMinC}–${day.tempMaxC}°C` : "";
          return `${day.date} ${day.summary}${temp}${rain}`;
        })
        .join("；");
      return `${report.resolvedName ?? report.query}从查询日起的预报：${preview}。这不一定是你出发那些天。`;
    })
    .join(" ");
}

export function sourcesFromTools(bundle: ToolBundle, mode: "llm" | "fallback"): Source[] {
  const sources: Source[] = [];
  for (const report of bundle.weather) {
    sources.push({
      title: report.stub
        ? `${report.query} 天气未取得`
        : `${report.resolvedName ?? report.query} 天气预报`,
      url: report.sourceUrl ?? undefined,
      kind: report.stub ? "stub" : "weather",
      note: report.note,
    });
  }
  for (const search of bundle.searches) {
    if (search.stub || search.results.length === 0) {
      sources.push({
        title: `网页检索：${search.query}`,
        kind: "stub",
        note: search.note ?? "没有可用的实时结果。",
      });
      continue;
    }
    for (const result of search.results.slice(0, 3)) {
      sources.push({
        title: result.title,
        url: result.url ?? undefined,
        kind: "search",
        note: result.snippet,
      });
    }
  }
  sources.push({
    title: mode === "llm" ? "大模型整理" : "路书本地规划器",
    kind: mode === "llm" ? "model" : "local",
    note: "行程文字由 AI 生成，可能有误，出发前请再核实。",
  });
  return sources.filter((source) => source.title.trim().length > 0);
}

function confirmedLines(brief: string): string[] {
  const index = brief.indexOf(CONFIRMED_MARK);
  if (index < 0) return [];
  return brief
    .slice(index + CONFIRMED_MARK.length)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 8);
}

function assumptionsFor(spec: TripSpec, reports: WeatherReport[]): string[] {
  const lines = [
    spec.daysAssumed
      ? "需求没写明天数，先按 3 天排。超过 14 天的长途在这一版里会截断。"
      : `天数按 ${spec.days} 天理解。`,
    spec.whenLabel ? `出行时间按「${spec.whenLabel}」理解，没有编造具体日期。` : "没有写具体日期，所以行程用第 1 天、第 2 天，不写日历。",
    spec.origin ? `出发地按「${spec.origin}」理解，往返交通只作背景，不代买。` : "没有写出发地，所以不排往返交通。",
    weatherAssumption(reports),
    ...confirmedLines(spec.rawBrief),
  ];
  for (const constraint of spec.constraints) lines.push(constraint);
  if (/不含往返|不含机票|不含火车/.test(spec.rawBrief)) {
    lines.push("预算说明里的市内花费不含往返大交通。");
  }
  return lines;
}

function warningsFor(spec: TripSpec, bundle: ToolBundle): string[] {
  const warnings = [
    "此内容由 AI 生成，仅供参考。",
    "路书不代订交通、住宿或门票，也不收款。",
  ];
  if (bundle.searches.every((search) => search.stub)) {
    warnings.push("网页检索没有使用实时结果，开放时间和价格请再核对。");
  }
  if (/春节|国庆|清明|五一|端午/.test(spec.rawBrief)) {
    warnings.push("假期人多，热门地方尽量早上到，并接受临时改计划。");
  }
  if (spec.party.kind === "family") {
    warnings.push("同行如果有老人或小孩，任何一项觉得赶，就直接删掉。");
  }
  return warnings;
}

function styleCopy(spec: TripSpec, style: DayStyle): {
  title: string;
  styleLabel: string;
  pace: string;
  suitability: string;
} {
  const where = spec.destinations.join("、");
  switch (style) {
    case "food":
      return {
        title: `${where} · 先把饭吃上`,
        styleLabel: "美食",
        pace: "用餐是主线，每天只留一个轻松的地方，吃完就收。",
        suitability: "适合这趟主要是为了吃、景点可有可无的人。",
      };
    case "family":
      return {
        title: `${where} · 大家跟得上`,
        styleLabel: "亲子 / 家庭",
        pace: "每天两个点，中间留出休息，室内选择优先。",
        suitability: "适合有老人或小孩、不想把假期过成拉练的家庭。",
      };
    case "rain":
      return {
        title: `${where} · 室内优先`,
        styleLabel: "雨天",
        pace: "先排有屋顶的地方，户外只作为天气好时的加项。",
        suitability: "适合预报不稳、或不想把行程押在晴天上的时候。",
      };
    case "budget":
      return {
        title: `${where} · 把钱花在吃上`,
        styleLabel: "节省",
        pace: "优先免费和低价，付费景点最多留一个。",
        suitability: "适合总预算紧、愿意用步行换门票的人。",
      };
    case "business":
      return {
        title: `${where} · 正事之后`,
        styleLabel: "出差顺路",
        pace: "白天留给工作，只在晚上和最后一天下午出门。",
        suitability: "适合不想为了打卡影响正事的人。",
      };
    case "slow":
      return {
        title: `${where} · 少赶路`,
        styleLabel: "慢",
        pace: "每天一两处，留出坐下来的时间，不把城市走穿。",
        suitability: "适合一个人走走停停、不想要清单的行程。",
      };
    case "relaxed":
      return {
        title: `${where} · 松一点`,
        styleLabel: "松弛",
        pace: "比经典方案少一个点，下午可以提前结束。",
        suitability: "适合想看主要地方、但拒绝特种兵的人。",
      };
    default:
      return {
        title: `${where} · 按图走路`,
        styleLabel: "经典",
        pace: "每天大约三个点，按顺路排，不来回折返。",
        suitability: "适合想把这一带的代表性地方看一遍的人。",
      };
  }
}

function buildDay(options: {
  dayNumber: number;
  cityName: string;
  spec: TripSpec;
  style: DayStyle;
  pool: Place[];
  cursor: { n: number; used: Set<string> };
  usedFullDay: { value: boolean };
  cityDayIndex: number;
}): ItineraryDay {
  const guide = guideFor(options.cityName);
  const emphasizeRain = options.style === "rain" || options.spec.themes.includes("rain");
  const meals = mealsFor(guide, options.cityDayIndex);
  const base: Omit<ItineraryDay, "items" | "title" | "theme"> = {
    day: options.dayNumber,
    city: guide.name,
    meals,
    stayNote: stayNote(guide, options.spec),
    rainPlanB: rainPlan(guide, emphasizeRain),
  };

  const keywordFull = options.pool.find(
    (place) =>
      place.fullDay &&
      !options.usedFullDay.value &&
      place.keywords.some((keyword) => keyword && options.spec.rawBrief.includes(keyword)),
  );
  if (keywordFull && options.style !== "business") {
    options.usedFullDay.value = true;
    return {
      ...base,
      title: keywordFull.name,
      theme: "这一天只做这一件",
      items: [
        item("早上出发", keywordFull, " 不要把别的景点叠在同一天。"),
        {
          time: "晚上",
          title: "回住处休息",
          detail: "这一天的路程已经够了。晚饭在住处附近解决。",
          area: guide.name,
        },
      ],
    };
  }

  if (options.style === "business") {
    const evening = options.pool.find((place) => place.evening) ?? options.pool[0];
    const afternoon = options.pool.find((place) => !place.evening) ?? evening;
    const isLast = options.dayNumber === options.spec.days;
    const chosen = isLast ? afternoon : evening;
    return {
      ...base,
      title: isLast ? "下午再出门" : "下班之后",
      theme: "工作优先",
      items: [
        {
          time: isLast ? "白天" : "白天",
          title: "时间留给正事",
          detail: isLast
            ? "如果下午能空出来，再按下面走。如果会议结束得晚，这一项取消。"
            : "路书不排白天的工作。结束之后再出门，不要为了景点请假。",
          area: guide.name,
        },
        chosen
          ? item(isLast ? "下午" : "晚上", chosen, " 看一个地方就够。")
          : {
              time: "晚上",
              title: "住处附近走走",
              detail: "没有必须打卡的地方。吃完饭早点休息。",
            },
      ],
    };
  }

  if (options.style === "food") {
    const sight =
      options.pool.find((place) => !options.cursor.used.has(place.name)) ??
      options.pool[options.cursor.n % options.pool.length];
    if (sight) options.cursor.used.add(sight.name);
    options.cursor.n += 1;
    return {
      ...base,
      title: meals[0] ?? "吃",
      theme: "吃为主",
      items: [
        {
          time: "早上",
          title: meals[0] ?? "早餐",
          detail: "把这一顿当成上午的安排。排队超过二十分钟就换下一家。",
          area: guide.name,
          estCost: "按人均一顿家常估算",
        },
        sight
          ? item("下午", sight, " 景点点到为止，看完就去解决下一顿。")
          : {
              time: "下午",
              title: "回住处歇一歇",
              detail: "留出胃和脚的空档。",
            },
        {
          time: "晚上",
          title: meals[2] ?? "晚饭",
          detail: "夜宵或晚饭吃完就回，不把夜晚排满。",
          area: guide.name,
        },
      ],
    };
  }

  const count = options.style === "family" || options.style === "slow" || options.style === "relaxed" ? 2 : 3;
  const picked: Place[] = [];
  for (const place of options.pool) {
    if (picked.length >= count) break;
    if (options.cursor.used.has(place.name)) continue;
    picked.push(place);
    options.cursor.used.add(place.name);
  }
  if (picked.length === 0) {
    const fallback = options.pool[options.cursor.n % Math.max(options.pool.length, 1)];
    if (fallback) picked.push(fallback);
  }
  const times = earlyBird(options.spec)
    ? ["早上 8:00 前", "上午结束这一站", "下午换个不排队的地方"]
    : options.style === "family"
      ? ["上午", "下午"]
      : options.style === "slow" || options.style === "relaxed"
        ? ["上午", "傍晚"]
        : ["上午", "下午", "晚上"];

  return {
    ...base,
    title: picked[0]?.name ?? guide.name,
    theme: options.style === "family" ? "留出休息" : options.style === "budget" ? "少花钱" : "顺路",
    items: picked.map((place, index) =>
      item(times[index] ?? "接着", place, options.style === "family" ? " 累了就在附近坐下，不必走完。" : ""),
    ),
  };
}

function applyBriefHints(day: ItineraryDay, spec: TripSpec): ItineraryDay {
  const brief = spec.rawBrief;
  const items = day.items.map((item) => ({ ...item }));
  const first = items[0];
  if (!first) return day;
  const touch = (time: string, extra: string) => {
    const current = items[0];
    if (!current) return;
    items[0] = { ...current, time, detail: `${current.detail}${extra}` };
  };
  let changed = false;
  if (day.day === 1 && /按到达、抵达理解/.test(brief)) {
    touch("抵达之后", " 时刻按到达理解，到了再开始。");
    changed = true;
  } else if (day.day === 1 && /按出发、发车理解/.test(brief)) {
    touch("发车之后", " 时刻按出发理解，不是到达。路上不排景点。");
    changed = true;
  }
  if ((day.day === 1 && /上午不排景点/.test(brief)) || (day.day === 2 && /那天上午不排景点/.test(brief))) {
    touch("下午", " 上午留给硬性安排，不排景点。");
    changed = true;
  } else if (day.day === 1 && /下午不排景点/.test(brief)) {
    touch("傍晚", " 下午留给硬性安排。");
    changed = true;
  }
  return changed ? { ...day, items } : day;
}

function buildDays(spec: TripSpec, style: DayStyle): ItineraryDay[] {
  const cities = allocateCities(spec.destinations, spec.days);
  const cursors = new Map<
    string,
    { n: number; usedFullDay: { value: boolean }; cityDay: number; used: Set<string> }
  >();
  return cities.map((cityName, index) => {
    const state = cursors.get(cityName) ?? {
      n: 0,
      usedFullDay: { value: false },
      cityDay: 0,
      used: new Set<string>(),
    };
    cursors.set(cityName, state);
    const pool = rankPlaces(guideFor(cityName), spec, style);
    const day = buildDay({
      dayNumber: index + 1,
      cityName,
      spec,
      style,
      pool,
      cursor: state,
      usedFullDay: state.usedFullDay,
      cityDayIndex: state.cityDay,
    });
    state.cityDay += 1;
    return applyBriefHints(day, spec);
  });
}

function makeVariant(spec: TripSpec, style: DayStyle, id: string, bundle: ToolBundle, mode: "llm" | "fallback"): PlanVariant {
  const copy = styleCopy(spec, style);
  const where = spec.destinations.join("、");
  return {
    id,
    title: copy.title,
    style: copy.styleLabel,
    summary: `${spec.whenLabel ? `${spec.whenLabel}，` : ""}${spec.party.summary}在${where}安排 ${spec.days} 天。${copy.pace}`,
    pace: copy.pace,
    budgetNote: budgetNote(spec),
    suitability: copy.suitability,
    days: buildDays(spec, style),
    sources: sourcesFromTools(bundle, mode),
    assumptions: assumptionsFor(spec, bundle.weather),
    warnings: warningsFor(spec, bundle),
    aiGenerated: true,
  };
}

export function buildFallbackVariants(
  spec: TripSpec,
  bundle: ToolBundle,
  mode: "llm" | "fallback" = "fallback",
): PlanVariant[] {
  const classic = makeVariant(spec, "classic", "a", bundle, mode);
  const otherStyle = alternateStyle(spec.themes);
  const other = makeVariant(spec, otherStyle === "classic" ? "relaxed" : otherStyle, "b", bundle, mode);
  if (other.title === classic.title) {
    other.title = `${spec.destinations.join("、")} · 另一套走法`;
  }
  return [classic, other];
}

export function contrastFor(variants: PlanVariant[]): string {
  const [first, second] = variants;
  if (!first || !second) return "先看一套能落地的走法。";
  return `「${first.title}」${first.pace}「${second.title}」${second.pace}`;
}

export function planQueries(spec: TripSpec): string[] {
  const queries = spec.destinations.slice(0, 3).map((city) => `${city} 旅行 开放时间`);
  const theme = spec.themes.find((item) => item !== "classic" && item !== "outbound");
  const label: Partial<Record<Theme, string>> = {
    food: "美食",
    family: "亲子 行程",
    rain: "室内 雨天",
    slow: "散步",
    budget: "免费",
    business: "晚上",
  };
  if (theme && label[theme]) queries.push(`${spec.destinations[0]} ${label[theme]}`);
  return queries.slice(0, 4);
}

export function emptyBundle(): ToolBundle {
  return { searches: [], weather: [] };
}

export function trimBundle(bundle: ToolBundle): unknown {
  return {
    searches: bundle.searches.map((search) => ({
      query: search.query,
      provider: search.provider,
      stub: search.stub,
      note: search.note,
      results: search.results.slice(0, 4).map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.snippet.slice(0, 320),
      })),
    })),
    weather: bundle.weather,
  };
}
