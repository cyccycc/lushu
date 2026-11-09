import { blockedModelUrlMessage, modelHttpError, publicHttpsBase, readLlmEnv, resolveLlmBase } from "@lushu/llm";
import { config } from "dotenv";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyClarification,
  applyPlanFollowUp,
  assessClarification,
  formatDayWeather,
  hasLlmKey,
  parseBrief,
  parseZhNumber,
  runTravelAgent,
  SYSTEM_PROMPT,
  TOOL_PROMPTS,
  weatherHeaderText,
  type AgentResult,
  type PlanVariant,
} from "@lushu/agent";
import {
  applyPatch,
  buildDraft,
  buildDraftFromSpec,
  forecastDaysThrough,
  normalizeWeatherQuery,
  parseTime,
  planAssumptionEdit,
  planLate,
  planMessage,
  planRain,
  planTired,
  shanghaiMinutes,
  specFromExtract,
  specFromRules,
  snapForTripDay,
  undoLast,
  type Roadbook,
  type RoadbookItem,
} from "@lushu/agent/roadbook";
import { extractBrief, parseExtract, validateExtract, type TripExtract } from "@lushu/agent/roadbook-server";

config({ path: path.resolve(process.cwd(), ".env") });

type Checks = {
  minDays: number;
  keywords: string[];
  budgetIncludes?: string;
  requireRainPlan?: boolean;
  minVariants?: number;
};

type Fixture = {
  id: string;
  title: string;
  brief: string;
  expect?: "clarify" | "plan";
  checks: Checks;
};

const root = path.dirname(fileURLToPath(import.meta.url));
const live = process.argv.includes("--live");

function assertParser(): string | null {
  const cases: [string, number][] = [
    ["八", 8],
    ["十二", 12],
    ["二十", 20],
    ["两百", 200],
    ["八百", 800],
    ["两千", 2000],
    ["一千五", 1500],
    ["一千五百", 1500],
    ["两万", 20000],
  ];
  for (const [raw, expected] of cases) {
    const got = parseZhNumber(raw);
    if (got !== expected) return `parseZhNumber(${raw}) = ${got}, expected ${expected}`;
  }
  if (!SYSTEM_PROMPT.includes("不预订") && !SYSTEM_PROMPT.includes("不代订")) {
    return "system prompt should refuse booking";
  }
  if (!SYSTEM_PROMPT.includes("不收款")) return "system prompt should refuse payment";
  if (!TOOL_PROMPTS.web_search.includes("web_search")) return "missing web_search tool prompt";
  if (!TOOL_PROMPTS.weather.includes("weather")) return "missing weather tool prompt";
  return null;
}

function assertClarify(): string | null {
  const brief = "周五2点高铁去济南";
  const assessment = assessClarification(brief);
  if (!assessment.needsClarify) return "ambiguous train brief should ask before planning";
  if (assessment.questions.length < 2 || assessment.questions.length > 3) {
    return `expected 2-3 questions, got ${assessment.questions.length}`;
  }
  const time = assessment.questions.find((question) => question.id === "transport-time");
  if (!time) return "missing depart vs arrive question";
  if (time.assumedId !== "depart") return "must not default the clock to arrival";
  const rendered = JSON.stringify(assessment);
  if (rendered.includes("14:00") || rendered.includes("14点")) {
    return "must not rewrite 2点 as 14:00";
  }
  if (!assessment.questions.some((question) => question.id === "duration")) return "missing days question";
  if (!assessment.questions.some((question) => question.id === "party")) return "missing party question";
  if (!assessment.assumptions.some((line) => line.includes("出发"))) {
    return "defaults should say the clock is treated as departure";
  }

  const checkup = assessClarification("下周去杭州，中间要体检");
  if (!checkup.questions.some((question) => question.id === "hard-slot")) {
    return "checkup should ask for a time slot";
  }
  if (checkup.questions.length > 3) return "checkup brief asked too many questions";

  const explicit = assessClarification("周五下午2点的高铁从上海出发去济南，当天往返，1个人。");
  if (explicit.questions.some((question) => question.id === "transport-time")) {
    return "explicit departure should not ask depart vs arrive";
  }

  const confirmed = applyClarification(brief, {
    "transport-time": "depart",
    duration: "daytrip",
    party: "1",
  });
  if (assessClarification(confirmed).needsClarify) return "confirmed brief should not ask again";
  const spec = parseBrief(confirmed);
  if (spec.days !== 1 || spec.daysAssumed) return `confirmed day trip parsed as ${spec.days} assumed=${spec.daysAssumed}`;
  if (spec.party.count !== 1) return "confirmed party should be 1";
  if (!spec.destinations.includes("济南")) return `destination parsed as ${spec.destinations.join(",")}`;
  return null;
}

function checkWeather(result: AgentResult, liveMode: boolean): string | null {
  for (const variant of result.variants) {
    const header = weatherHeaderText(variant.days);
    if (!header.includes("·") && !header.includes("暂不可用")) return `${variant.id} weather header is empty`;
    for (const day of variant.days) {
      const line = formatDayWeather(day.weather, day.city);
      if (!day.weather) return `${variant.id} day ${day.day} missing weather`;
      if (!liveMode && day.weather.available) return `${variant.id} offline weather invented numbers`;
      if (!liveMode && !line.includes("暂不可用")) return `${variant.id} offline weather line: ${line}`;
      if (!liveMode && !header.includes("暂不可用")) return `${variant.id} offline header hid the stub`;
      if (liveMode && day.weather.available) {
        if (day.weather.tempMinC == null || day.weather.tempMaxC == null) {
          return `${variant.id} day ${day.day} missing temperature`;
        }
        if (day.weather.precipProbability == null) return `${variant.id} day ${day.day} missing precip`;
        if (!line.includes(String(day.weather.precipProbability))) return `${variant.id} precip not in the day line`;
        if (!line.includes("°C")) return `${variant.id} temperature not in the day line`;
      }
      if (liveMode && !day.weather.available && !line.includes("暂不可用")) {
        return `${variant.id} unavailable weather is not stated`;
      }
    }
  }
  return null;
}

function checkVariant(variant: PlanVariant, checks: Checks): string | null {
  if (variant.aiGenerated !== true) return `${variant.id} is not marked AI-generated`;
  if (variant.days.length < checks.minDays) {
    return `${variant.id} has ${variant.days.length} days, want >= ${checks.minDays}`;
  }
  if (!variant.budgetNote || variant.budgetNote.trim().length < 8) {
    return `${variant.id} is missing a budget note`;
  }
  if (!variant.sources || variant.sources.length < 1) {
    return `${variant.id} is missing sources`;
  }
  for (const day of variant.days) {
    if (!day.items || day.items.length < 1) return `${variant.id} day ${day.day} has no items`;
    if (checks.requireRainPlan && !day.rainPlanB.trim()) {
      return `${variant.id} day ${day.day} has no rain plan`;
    }
  }
  return null;
}

function checkResult(result: AgentResult, checks: Checks): string | null {
  const minVariants = checks.minVariants ?? 2;
  if (result.variants.length < minVariants) {
    return `expected ${minVariants} variants, got ${result.variants.length}`;
  }
  if (result.aiGenerated !== true) return "result is not marked AI-generated";
  if (result.usage.steps > result.usage.maxSteps) {
    return `steps ${result.usage.steps} over limit ${result.usage.maxSteps}`;
  }
  if (result.usage.toolCalls > result.usage.maxToolCalls) {
    return `tool calls ${result.usage.toolCalls} over limit ${result.usage.maxToolCalls}`;
  }
  if (result.usage.estimatedUsd > result.usage.maxCostUsd + 1e-9) {
    return `estimated cost ${result.usage.estimatedUsd} over $${result.usage.maxCostUsd}`;
  }
  const phases = new Set(result.steps.map((step) => step.phase));
  for (const phase of ["planning", "searching", "awaiting_confirm"] as const) {
    if (!phases.has(phase)) return `timeline missing ${phase}`;
  }
  const blob = JSON.stringify(result.variants);
  for (const keyword of checks.keywords) {
    if (!blob.includes(keyword)) return `missing keyword「${keyword}」`;
  }
  if (checks.budgetIncludes) {
    const notes = result.variants.map((variant) => variant.budgetNote).join("\n");
    if (!notes.includes(checks.budgetIncludes)) {
      return `budget note missing ${checks.budgetIncludes}`;
    }
  }
  for (const variant of result.variants) {
    const problem = checkVariant(variant, checks);
    if (problem) return problem;
  }
  return null;
}

async function loadFixtures(): Promise<Fixture[]> {
  const dir = path.join(root, "fixtures");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  const fixtures: Fixture[] = [];
  for (const file of files) {
    const raw = await readFile(path.join(dir, file), "utf8");
    fixtures.push(JSON.parse(raw) as Fixture);
  }
  return fixtures;
}

function assertRoadbook(): string | null {
  const west = parseBrief("这周末想去西湖走走，两天，两个人");
  if (west.destinations[0] !== "杭州") return `西湖应解析为杭州，得到 ${west.destinations.join(",")}`;
  if (west.origin) return "西湖 brief 不应把杭州当地出发地";
  const fromShanghai = parseBrief("从上海去西湖走走，两天");
  if (fromShanghai.origin !== "上海" || fromShanghai.destinations[0] !== "杭州") {
    return `上海到西湖解析为 ${fromShanghai.origin} -> ${fromShanghai.destinations.join(",")}`;
  }
  const tokyo = parseBrief("五月想去东京五天，从上海出发，两个人，想看市区和一天迪士尼。");
  if (!tokyo.destinations.includes("东京") || tokyo.destinations.includes("上海")) {
    return `东京行程被改成 ${tokyo.destinations.join(",")}`;
  }

  const weatherQuery = normalizeWeatherQuery("这周末想去西湖走走，两天，两个人");
  if (weatherQuery.query !== "杭州" || weatherQuery.alternateName !== "Hangzhou") {
    return `天气查询应是杭州，得到 ${weatherQuery.query}`;
  }
  const wholeSentence = normalizeWeatherQuery("请根据这句话安排行程，但是不要把整句拿去当地名查询，这里真的没有具体地名");
  if (!wholeSentence.query || wholeSentence.query.length > 12) {
    return `整句被当成了地名：${wholeSentence.query}`;
  }

  const now = new Date("2026-11-14T02:00:00Z");
  let n = 0;
  const random = () => `t${(n += 1)}`;
  const book = buildDraft("今天去西湖两天，两个人", { id: "book1", now, random });
  if (book.city !== "杭州") return `草稿城市 ${book.city}`;
  if (book.startDate !== "2026-11-14") return `写了今天，出发日应是 2026-11-14，得到 ${book.startDate}`;
  if (book.question) return "西湖草稿不应追问";
  if (book.assumptions.length < 4) return "缺少假设标签";
  if (!book.assumptions.some((item) => item.key === "city" && item.inferred && item.value === "杭州")) {
    return "目的地假设应标成由西湖推断的杭州";
  }
  const required: (keyof RoadbookItem)[] = [
    "id",
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
    "locked",
    "priority",
  ];
  for (const entry of book.items) {
    for (const key of required) {
      if (!(key in entry)) return `行程项缺少 ${key}`;
    }
    if (entry.lat !== null && typeof entry.lat !== "number") return "纬度类型不对";
  }
  if (!book.items.some((item) => item.title === "西湖")) return "草稿应包含西湖";
  if (book.patchHistory.length < 1 || book.undo) return "草稿应记下生成补丁且还不能撤销";

  const vague = buildDraft("想出去玩", { id: "book2", now, random });
  if (!vague.question || vague.assumptions.filter((item) => item.inferred).length < 1) {
    return "缺城市时应只留一个追问，并标出假设";
  }

  const lake = book.items.find((item) => item.title === "西湖");
  const breakfast = book.items.find((item) => item.type === "餐" && item.dayIndex === 1);
  if (!lake || !breakfast) return "草稿结构不完整";
  const lockedBook = {
    ...book,
    items: book.items.map((item) => (item.id === lake.id ? { ...item, locked: true } : item)),
  };
  const denied = applyPatch(lockedBook, {
    label: "改锁定",
    kind: "user",
    ops: [{ op: "update", id: lake.id, fields: { title: "不该改" } }],
  });
  if (denied.ok) return "锁定项不应被补丁修改";
  if (denied.book.items.find((item) => item.id === lake.id)?.title !== "西湖") return "拒绝补丁时不应改原路书";

  const badTime = applyPatch(book, {
    label: "坏时间",
    kind: "user",
    ops: [{ op: "update", id: breakfast.id, fields: { startTime: "明天" } }],
  });
  if (badTime.ok) return "无法解析的时间应被拒绝";

  const overlap = applyPatch(book, {
    id: "p_overlap",
    label: "重叠",
    kind: "user",
    ops: [
      { op: "update", id: breakfast.id, fields: { startTime: "10:00", durationMinutes: 120 } },
      {
        op: "update",
        id: lake.id,
        fields: { startTime: "10:30", durationMinutes: 60 },
      },
    ],
  });
  if (!overlap.ok) return `时间冲突应修正而不是失败：${overlap.error}`;
  const moved = overlap.book.items.find((item) => item.id === lake.id);
  if (!moved || parseTime(moved.startTime) !== parseTime("12:00")) {
    return `重叠项应被推到 12:00，得到 ${moved?.startTime}`;
  }
  if (!moved.highlight) return "被修正的项应高亮";

  const undone = undoLast(overlap.book);
  if (!undone.ok) return undone.error;
  if (undone.book.items.find((item) => item.id === lake.id)?.startTime !== lake.startTime) {
    return "撤销后应回到上一份时间";
  }
  if (undone.book.undo) return "撤销后不应再叠一层撤销";

  const late = planLate(lockedBook, now);
  if (!late.request) return late.note;
  const shifted = applyPatch(lockedBook, { ...late.request, id: "p_late" });
  if (!shifted.ok) return shifted.error;
  const lockedAfter = shifted.book.items.find((item) => item.id === lake.id);
  if (!lockedAfter || lockedAfter.startTime !== lake.startTime) return "晚了 1 小时不应挪动锁定项";
  const breakfastAfter = shifted.book.items.find((item) => item.id === breakfast.id);
  if (!breakfastAfter || breakfastAfter.startTime !== breakfast.startTime) {
    return `已结束的早餐不应被顺延，${breakfast.startTime} -> ${breakfastAfter?.startTime}`;
  }
  const lunch = book.items.find((item) => item.dayIndex === 1 && item.startTime === "12:30");
  const lunchAfter = lunch ? shifted.book.items.find((item) => item.id === lunch.id) : undefined;
  const beforeMin = lunch ? parseTime(lunch.startTime) : null;
  const afterMin = lunchAfter ? parseTime(lunchAfter.startTime) : null;
  if (beforeMin == null || afterMin == null || afterMin < beforeMin + 60) {
    return `未结束的午餐应至少顺延 60 分钟，${lunch?.startTime} -> ${lunchAfter?.startTime}`;
  }
  if (shifted.book.items.some((item) => item.title === "可砍的夜走" && item.dayIndex === 1)) {
    return "放不下的可砍项应被砍掉";
  }
  if (!shifted.book.items.some((item) => item.highlight)) return "顺延的项应高亮";
  const dropped = shifted.book.patchHistory.at(-1)?.dropped ?? [];
  if (!dropped.some((item) => item.title === "可砍的夜走")) return "砍掉的项应记在补丁里";
  const pace = book.assumptions.find((item) => item.key === "pace");
  if (!pace) return "缺少节奏假设";
  const edited = planAssumptionEdit(book, pace.id, "更松", () => "edit");
  if (!edited.request) return edited.note;
  const tagged = applyPatch(book, { ...edited.request, id: "p_tag" });
  if (!tagged.ok) return tagged.error;
  if (!tagged.book.assumptions.find((item) => item.id === pace.id)?.changed) return "改过的假设应高亮";
  if (tagged.book.assumptions.some((item) => item.id !== pace.id && item.changed)) return "没改的假设不应高亮";

  const rainy = {
    ...book,
    weather: [
      {
        city: "杭州",
        query: "杭州",
        date: "2026-11-14",
        condition: "小雨",
        tempMinC: 12,
        tempMaxC: 16,
        precipProbability: 80,
        available: true,
        note: "",
        fetchedAt: now.toISOString(),
        sourceUrl: null,
      },
    ],
  };
  const rain = planRain(rainy, now);
  if (!rain.request) return rain.note;
  const rained = applyPatch(rainy, { ...rain.request, id: "p_rain" });
  if (!rained.ok) return rained.error;
  const lakeAfterRain = rained.book.items.find((item) => item.id === lake.id);
  if (!lakeAfterRain || lakeAfterRain.title !== "西湖" || lakeAfterRain.indoor) {
    return "下雨不应直接换掉未锁定的必去西湖";
  }
  if (!rain.note.includes("西湖是户外，下雨要不要去")) return `下雨应询问必去户外：${rain.note}`;
  if (!rained.book.verifyChecklist.some((item) => item.text.includes("西湖是户外，下雨要不要去"))) {
    return "下雨应把必去户外写进核实清单";
  }
  if (rained.book.items.some((item) => item.dayIndex === 1 && item.title === "灵隐寺")) {
    return "下雨仍应替换未锁定、非必去的户外景点";
  }
  const tired = planTired(book, now, random);
  if (!tired.request) return tired.note;
  const rested = applyPatch(book, { ...tired.request, id: "p_tired" });
  if (!rested.ok) return rested.error;
  if (!rested.book.items.some((item) => item.title === "坐下休息" && item.dayIndex === 1)) {
    return "累了应插入休息";
  }
  if (rested.book.items.some((item) => item.dayIndex === 1 && item.type === "自由")) {
    return "累了应砍掉自由活动";
  }
  const keptRest: RoadbookItem = {
    ...breakfast,
    id: "i_oldrest",
    startTime: "21:10",
    durationMinutes: 20,
    title: "原来的休息",
    type: "休息",
    priority: "想去",
    indoor: true,
    locked: false,
    status: "待做",
    highlight: false,
  };
  const withRest = { ...book, items: [...book.items, keptRest] };
  const tiredKeep = planTired(withRest, now, random);
  if (!tiredKeep.request) return tiredKeep.note;
  if (tiredKeep.request.ops.some((op) => op.op === "remove" && op.id === keptRest.id)) {
    return "累了不应砍掉已有休息";
  }
  const keptApplied = applyPatch(withRest, { ...tiredKeep.request, id: "p_keeprest" });
  if (!keptApplied.ok) return keptApplied.error;
  if (!keptApplied.book.items.some((item) => item.id === keptRest.id)) return "累了应留下已有休息";
  const evening = planTired(book, new Date("2026-11-14T10:00:00Z"), random);
  if (!evening.request) return evening.note;
  const eveningBook = applyPatch(book, { ...evening.request, id: "p_evening" });
  if (!eveningBook.ok) return eveningBook.error;
  const sit = eveningBook.book.items.find((item) => item.title === "坐下休息");
  const sitStart = sit ? parseTime(sit.startTime) : null;
  if (sitStart == null || sitStart <= 18 * 60) return `休息应排在现在之后，得到 ${sit?.startTime}`;

  const day1Sights = new Set(
    book.items.filter((item) => item.dayIndex === 1 && item.type === "景点").map((item) => item.title),
  );
  const day2Sights = book.items.filter((item) => item.dayIndex === 2 && item.type === "景点").map((item) => item.title);
  if (day2Sights.length < 1 || day2Sights.some((title) => day1Sights.has(title))) {
    return `第 2 天景点应和第 1 天错开：${day2Sights.join(",")}`;
  }
  const tai = parseBrief("想去泰山，两天");
  if (tai.destinations[0] !== "泰安") return `泰山应解析为泰安，得到 ${tai.destinations.join(",")}`;
  const taiBook = buildDraft("想去泰山，两天", { id: "tai", now, random });
  if (taiBook.city !== "泰安") return `泰山草稿城市 ${taiBook.city}`;
  if (!taiBook.items.some((item) => item.title.includes("泰山") && item.priority === "必去")) {
    return "泰山应作为必去写进草稿";
  }
  const tai3 = buildDraft("想去泰山，三天", { id: "tai3", now, random });
  const taiSeen = tai3.items.filter((item) => item.type === "景点" && item.title.includes("泰山"));
  if (taiSeen.length !== 1) {
    return `泰山应只出现一次，得到 ${taiSeen.map((item) => `${item.dayIndex} ${item.startTime}`).join(",")}`;
  }
  if (tai3.items.some((item) => item.title === "老街走一段" && item.priority === "必去")) {
    return "老街走一段不应标成必去";
  }
  const tai1 = buildDraft("想去泰山，一天", { id: "tai1", now, random });
  const climb = tai1.items.find((item) => item.type === "景点" && item.title.includes("泰山"));
  if (!climb || climb.durationMinutes < 300 || climb.durationMinutes > 480) {
    return `一日泰山应为 5–8 小时，得到 ${climb?.durationMinutes}`;
  }
  if (tai1.items.some((item) => item.title === "中心城区步行")) return "一日泰山不应排中心城区步行";
  const taiDays = tai3.assumptions.find((item) => item.key === "days");
  if (!taiDays) return "泰山草稿缺少天数";
  const toOne = planAssumptionEdit(tai3, taiDays.id, "1 天", random, now);
  if (!toOne.request) return toOne.note;
  const oneApplied = applyPatch(tai3, { ...toOne.request, id: "p_tai1" });
  if (!oneApplied.ok) return oneApplied.error;
  const climbs = oneApplied.book.items.filter((item) => item.type === "景点" && item.title.includes("泰山"));
  if (climbs.length !== 1 || !climbs[0] || climbs[0].durationMinutes < 300 || climbs[0].durationMinutes > 480) {
    return `缩短成 1 天后泰山应为一次 5–8 小时，得到 ${climbs.map((item) => item.durationMinutes).join(",")}`;
  }
  if (oneApplied.book.items.some((item) => item.title === "中心城区步行")) {
    return "缩短成 1 天后不应留下中心城区步行";
  }

  const daysTag = book.assumptions.find((item) => item.key === "days");
  if (!daysTag) return "缺少天数假设";
  const three = planMessage(book, "改成3天", random, now);
  if (!three.request || three.request.kind !== "assumption") return `「3天」应改假设：${three.note}`;
  const threeBook = applyPatch(book, { ...three.request, id: "p_days3" });
  if (!threeBook.ok) return threeBook.error;
  if (!threeBook.book.items.some((item) => item.dayIndex === 3)) return "改成 3 天应生成第 3 天";
  if (threeBook.book.assumptions.find((item) => item.key === "days")?.value !== "3 天") return "天数标签应是 3 天";
  const lockedDays = {
    ...book,
    items: book.items.map((item) => (item.id === lake.id ? { ...item, locked: true } : item)),
  };
  const regen = planAssumptionEdit(lockedDays, daysTag.id, "3 天", random, now);
  if (!regen.request) return regen.note;
  const regenBook = applyPatch(lockedDays, { ...regen.request, id: "p_regen" });
  if (!regenBook.ok) return regenBook.error;
  const keptLake = regenBook.book.items.find((item) => item.id === lake.id);
  if (!keptLake?.locked || keptLake.startTime !== lake.startTime || keptLake.title !== "西湖") {
    return "改天数应保留锁定的西湖";
  }
  if (regenBook.book.items.some((item) => item.id === breakfast.id)) return "未锁定项应在改天数时重排";
  const day2Item = book.items.find((item) => item.dayIndex === 2);
  if (!day2Item) return "草稿应有第 2 天";
  const blockedShort = planAssumptionEdit(
    { ...book, items: book.items.map((item) => (item.id === day2Item.id ? { ...item, locked: true } : item)) },
    daysTag.id,
    "1 天",
    random,
    now,
  );
  if (blockedShort.request) return "缩短时不应丢掉范围外的锁定项";
  const tea: RoadbookItem = {
    ...breakfast,
    id: "i_tea",
    title: "我的茶歇",
    type: "休息",
    startTime: "16:30",
    durationMinutes: 40,
    priority: "想去",
    indoor: true,
    locked: false,
    note: "自己加的",
    source: { kind: "推断", note: "用户添加" },
  };
  const withTea = applyPatch(book, {
    id: "p_tea",
    label: "加上我的茶歇",
    kind: "user",
    ops: [{ op: "add", item: tea }],
  });
  if (!withTea.ok) return withTea.error;
  const notedBreakfast = applyPatch(withTea.book, {
    id: "p_breakfast_note",
    label: "改早餐",
    kind: "user",
    ops: [{ op: "update", id: breakfast.id, fields: { note: "少油" } }],
  });
  if (!notedBreakfast.ok) return notedBreakfast.error;
  const shortenTea = planAssumptionEdit(notedBreakfast.book, daysTag.id, "1 天", random, now);
  if (!shortenTea.request) return shortenTea.note;
  if (!shortenTea.note.includes("未锁定的改动已重排")) return `改天数应提示未锁定改动：${shortenTea.note}`;
  const teaBook = applyPatch(notedBreakfast.book, { ...shortenTea.request, id: "p_tea_short" });
  if (!teaBook.ok) return teaBook.error;
  if (!teaBook.book.items.some((item) => item.id === "i_tea" && item.title === "我的茶歇")) {
    return "缩短天数应留下用户加的茶歇";
  }
  if (teaBook.book.items.some((item) => item.id === breakfast.id)) return "未锁定的原早餐仍应重排";
  const party = planMessage(book, "改成4个人", random, now);
  if (!party.request?.assumptions?.some((item) => item.key === "party" && item.value === "4 个人")) {
    return `人数应改成 4 个人：${party.note}`;
  }
  const when = book.assumptions.find((item) => item.key === "when");
  if (!when) return "缺少时间假设";
  const sat = planAssumptionEdit(book, when.id, "周六", random, new Date("2026-11-13T04:00:00Z"));
  if (sat.request?.startDate !== "2026-11-14") return `周六应是 2026-11-14，得到 ${sat.request?.startDate}`;

  const unlocked = applyPatch(lockedBook, {
    id: "p_unlock",
    label: "解锁",
    kind: "user",
    ops: [{ op: "update", id: lake.id, fields: { locked: false } }],
  });
  if (!unlocked.ok) return unlocked.error;
  if (unlocked.book.items.find((item) => item.id === lake.id)?.locked) return "应能解锁";
  const doneLocked = applyPatch(lockedBook, {
    id: "p_done_locked",
    label: "完成锁定",
    kind: "user",
    ops: [{ op: "update", id: lake.id, fields: { status: "已完成" } }],
  });
  if (!doneLocked.ok) return `锁定项应能改状态：${doneLocked.error}`;
  const doneLake = doneLocked.book.items.find((item) => item.id === lake.id);
  if (doneLake?.status !== "已完成" || doneLake.locked !== true) return "改状态不应解除锁定";

  const horizon = forecastDaysThrough("2026-11-16", 3, new Date("2026-11-14T02:00:00Z"));
  if (horizon < 5) return `预报应盖到行程最后一天，得到 ${horizon} 天`;
  const shiftedWeather = {
    ...book,
    startDate: "2026-11-16",
    weather: [
      { ...rainy.weather[0], date: "2026-11-14", condition: "晴", precipProbability: 0 },
      { ...rainy.weather[0], date: "2026-11-16", condition: "大雨", precipProbability: 90 },
    ],
  };
  if (snapForTripDay(shiftedWeather, 1)?.date !== "2026-11-16") return "天气应按出发日加天数对齐";
  const datedRain = planRain(shiftedWeather, new Date("2026-11-16T02:00:00Z"));
  if (!datedRain.note.includes("大雨")) return `下雨应使用当天预报，得到 ${datedRain.note}`;
  return null;
}

function assertLocalPhrases(): string | null {
  const now = new Date("2026-11-13T04:00:00Z");
  let n = 0;
  const random = () => `p${(n += 1)}`;
  const book = buildDraft("去西湖两天，两个人", { id: "phrases", now, random });
  const cases: [string, string][] = [
    ["1天", "1 天"],
    ["改成1天", "1 天"],
    ["只玩一天", "1 天"],
    ["只玩一日", "1 天"],
    ["玩2天", "2 天"],
    ["玩两天", "2 天"],
    ["玩两日", "2 天"],
    ["2天就行", "2 天"],
    ["两天就行", "2 天"],
    ["一天就行", "1 天"],
    ["两日就行", "2 天"],
  ];
  for (const [text, expected] of cases) {
    const plan = planMessage(book, text, random, now);
    const got = plan.request?.assumptions?.find((item) => item.key === "days")?.value;
    if (!plan.request || got !== expected) return `「${text}」应是 ${expected}，得到 ${got || plan.note || "没有请求"}`;
  }
  const party = planMessage(book, "两个人", random, now);
  if (!party.request?.assumptions?.some((item) => item.key === "party" && item.value === "两个人")) {
    return `「两个人」应改人数：${party.note}`;
  }
  const satGo = planMessage(book, "周六去", random, now);
  if (satGo.request?.startDate !== "2026-11-14") return `周六去应是 2026-11-14，得到 ${satGo.request?.startDate}`;
  const sun = planMessage(book, "改成周日", random, now);
  if (sun.request?.startDate !== "2026-11-15" || sun.request.assumptions?.find((item) => item.key === "when")?.value !== "周日") {
    return `改成周日应是周日 / 2026-11-15，得到 ${sun.request?.startDate}`;
  }
  const sat = planMessage(book, "改成周六", random, now);
  if (sat.request?.startDate !== "2026-11-14") return `改成周六应是 2026-11-14，得到 ${sat.request?.startDate}`;
  const mon = planMessage(book, "改成周一", random, now);
  if (mon.request?.startDate !== "2026-11-16") return `改成周一应是 2026-11-16，得到 ${mon.request?.startDate}`;
  const sundayGo = planMessage(book, "星期天去", random, now);
  if (sundayGo.request?.assumptions?.find((item) => item.key === "when")?.value !== "周日") {
    return "星期天去应写成周日";
  }
  const free = planMessage(book, "帮我把晚饭换到湖边", random, now);
  if (free.request || free.note) return `自由句子应留给模型，得到 ${free.note || "有请求"}`;
  const mixed = planMessage(book, "改成周日，晚饭别太晚", random, now);
  if (mixed.request || mixed.note) return `带补充的句子应留给模型，得到 ${mixed.note || "有请求"}`;
  const calendar = planMessage(book, "改成3日", random, now);
  if (calendar.request || calendar.note) return `「改成3日」应留给模型，得到 ${calendar.note || "有请求"}`;
  const days = book.assumptions.find((item) => item.key === "days");
  const when = book.assumptions.find((item) => item.key === "when");
  if (!days || !when) return "短语测试缺少假设";
  const editedDays = planAssumptionEdit(book, days.id, "只玩一天", random, now);
  if (editedDays.request?.title?.includes("1 天") !== true) return `假设里写「只玩一天」应改成 1 天：${editedDays.note}`;
  const editedWhen = planAssumptionEdit(book, when.id, "改成周日", random, now);
  if (editedWhen.request?.startDate !== "2026-11-15") return `假设里写「改成周日」应是 2026-11-15，得到 ${editedWhen.request?.startDate}`;
  return null;
}

function assertTiredClimb(): string | null {
  const now = new Date("2026-11-06T02:56:00Z");
  let n = 0;
  const random = () => `c${(n += 1)}`;
  const book = buildDraft("今天想去爬泰山", { id: "climb-now", now, random });
  if (book.startDate !== "2026-11-06") return `进行中的泰山应在今天，得到 ${book.startDate}`;
  const before = book.items.find((item) => item.type === "景点" && item.title.includes("泰山"));
  if (!before || before.durationMinutes < 300 || before.startTime !== "07:40") {
    return `泰山应是 07:40 起的长行程，得到 ${before?.startTime} / ${before?.durationMinutes}`;
  }
  const tired = planTired(book, now, random);
  if (!tired.request) return tired.note;
  const shortened = tired.request.ops.find(
    (op) => op.op === "update" && op.id === before.id && op.fields.durationMinutes != null && op.fields.durationMinutes <= 90,
  );
  if (shortened) return "累了不应把进行中的泰山压到 75 分钟左右";
  const applied = applyPatch(book, { ...tired.request, id: "p_climb" });
  if (!applied.ok) return applied.error;
  const climb = applied.book.items.find((item) => item.id === before.id);
  const end = climb ? (parseTime(climb.startTime) ?? 0) + climb.durationMinutes : null;
  const clock = shanghaiMinutes(now);
  if (!climb || climb.startTime !== before.startTime || end == null || end < clock) {
    return `进行中的泰山结束时间落到过去：${climb?.startTime} + ${climb?.durationMinutes}`;
  }
  if (climb.durationMinutes < 300) return `7 小时登山被压成 ${climb.durationMinutes} 分钟`;

  const early = new Date("2026-11-05T22:30:00Z");
  const ahead = buildDraft("今天想去爬泰山", { id: "climb-early", now: early, random });
  const aheadClimb = ahead.items.find((item) => item.type === "景点" && item.title.includes("泰山"));
  const aheadTired = planTired(ahead, early, random);
  if (!aheadTired.request || !aheadClimb) return aheadTired.note || "缺少泰山";
  const aheadApplied = applyPatch(ahead, { ...aheadTired.request, id: "p_climb_early" });
  if (!aheadApplied.ok) return aheadApplied.error;
  const kept = aheadApplied.book.items.find((item) => item.id === aheadClimb.id);
  if (!kept || kept.durationMinutes < 300) return `未开始的长途登山被压成 ${kept?.durationMinutes} 分钟`;

  const walk = buildDraft("今天去西湖两天", { id: "walk", now, random });
  const later = walk.items.find((item) => item.dayIndex === 1 && item.title === "灵隐寺");
  const walkTired = planTired(walk, now, random);
  if (!walkTired.request || !later) return walkTired.note || "缺少灵隐寺";
  const walkApplied = applyPatch(walk, { ...walkTired.request, id: "p_walk" });
  if (!walkApplied.ok) return walkApplied.error;
  const trimmed = walkApplied.book.items.find((item) => item.id === later.id);
  if (!trimmed || trimmed.durationMinutes !== 75) return `未开始的普通景点应缩短到 75 分钟，得到 ${trimmed?.durationMinutes}`;
  const underway = {
    ...walk,
    items: walk.items.map((item) =>
      item.id === later.id ? { ...item, startTime: "09:00", durationMinutes: 120, priority: "想去" as const, title: "湖边再走走" } : item,
    ),
  };
  const underwayPlan = planTired(underway, now, random);
  if (!underwayPlan.request) return underwayPlan.note;
  const pastEnd = underwayPlan.request.ops.find((op) => {
    if (op.op !== "update" || op.id !== later.id || op.fields.durationMinutes == null) return false;
    return (parseTime("09:00") ?? 0) + op.fields.durationMinutes < clock;
  });
  if (pastEnd) return "进行中的普通项目不应被改到现在之前";
  return null;
}

function assertUnsetDate(): string | null {
  const now = new Date("2026-11-06T02:56:00Z");
  let n = 0;
  const random = () => `d${(n += 1)}`;
  const unset = buildDraft("想去爬泰山", { id: "unset", now, random });
  const when = unset.assumptions.find((item) => item.key === "when");
  if (!when || when.value !== "日期未定") return `没写日期时应是日期未定，得到 ${when?.value}`;
  if (unset.startDate !== "2026-11-07") return `日期未定应从明天开始，得到 ${unset.startDate}`;
  const today = buildDraft("今天想去爬泰山", { id: "today", now, random });
  if (today.startDate !== "2026-11-06") return `写了今天仍应是今天，得到 ${today.startDate}`;
  const already = buildDraft("人已经在泰安，想爬泰山", { id: "already", now, random });
  if (already.startDate !== "2026-11-06") return `人已经在当地仍应是今天，得到 ${already.startDate}`;
  const picked = planAssumptionEdit(unset, when.id, "2026-12-01", random, now);
  if (picked.request?.startDate !== "2026-12-01") return `选定日期应保留，得到 ${picked.request?.startDate}`;
  const cleared = planAssumptionEdit(unset, when.id, "日期未定", random, now);
  if (cleared.request?.startDate !== "2026-11-07") return `改回日期未定应从明天开始，得到 ${cleared.request?.startDate}`;
  const may = buildDraft("五月想去东京五天", { id: "may", now, random });
  if (may.startDate !== "2026-11-06") return `写了月份时不应改成明天，得到 ${may.startDate}`;
  const wed = new Date("2026-11-04T02:00:00Z");
  const weekend = buildDraft("这周末去杭州两天", { id: "weekend", now: wed, random });
  if (weekend.startDate !== "2026-11-07") return `周末应是周六，得到 ${weekend.startDate}`;
  const satNow = new Date("2026-11-14T02:00:00Z");
  const satWeekend = buildDraft("这周末去杭州两天", { id: "satwk", now: satNow, random });
  if (satWeekend.startDate !== "2026-11-14") return `周六说周末应仍是当天，得到 ${satWeekend.startDate}`;
  return null;
}

const JINAN_BRIEF =
  "我今天下午 2 点的高铁，从上海去往济南。明天早上体检，在汉峪金谷那边，我已经订好了附近的酒店。明天下午 4 点半返程";
const SELF_TRIP = "从上海前往上海";

function blobHasSelfTrip(value: unknown): boolean {
  return JSON.stringify(value).includes(SELF_TRIP);
}

function assertJinanBook(book: Roadbook): string | null {
  if (book.city !== "济南") return `目的地应是济南，得到 ${book.city} / ${book.title}`;
  if (book.title.includes("上海")) return `标题不应是上海：${book.title}`;
  if (blobHasSelfTrip(book)) return "出现了从上海前往上海";
  if (book.startDate !== "2026-11-06") return `出发日应是 2026-11-06，得到 ${book.startDate}`;
  const days = book.items.reduce((max, item) => Math.max(max, item.dayIndex), 1);
  if (days !== 2) return `应是 2 天，得到 ${days}`;
  if (book.assumptions.find((item) => item.key === "days")?.value !== "2 天") return "天数标签应是 2 天";
  const locked = book.items.filter((item) => item.locked);
  if (!locked.some((item) => item.title === "从上海前往济南" && item.type === "交通")) return "去程未锁定";
  if (!locked.some((item) => item.dayIndex === 2 && item.type === "交通" && item.title.includes("济南") && item.title.includes("上海"))) {
    return "返程未锁定";
  }
  if (!locked.some((item) => item.title.includes("体检") && item.type === "办事")) return "体检未锁定";
  const checkup = book.items.find((item) => item.title.includes("体检"));
  const rideBack = book.items.find((item) => item.dayIndex === checkup?.dayIndex && item.locked && item.type === "交通" && item.title.includes("上海"));
  const checkupStart = checkup ? parseTime(checkup.startTime) : null;
  const backStart = rideBack ? parseTime(rideBack.startTime) : null;
  if (checkupStart == null || backStart == null || checkupStart >= backStart) return "体检应排在返程之前";
  if (book.items.some((item) => item.type === "景点")) return "办事行程不应塞景点";
  const text = JSON.stringify(book);
  for (const banned of ["武康路", "生煎", "外滩", "豫园"]) {
    if (text.includes(banned)) return `济南行程抄了上海的${banned}`;
  }
  if (!book.verifyChecklist.some((item) => item.text.includes("空腹"))) return "体检应追问是否空腹";
  if (!book.verifyChecklist.some((item) => item.text.includes("济南西"))) return "返程应提醒车站";
  if (!book.verifyChecklist.some((item) => item.text.includes("入住"))) return "已订酒店应核对入住时间";
  const ride = book.items.find((item) => item.title === "从上海前往济南");
  if (!ride || ride.durationMinutes !== 180 || ride.estimateSource !== "推断") {
    return `高铁时长应按 180 分钟推断，得到 ${ride?.durationMinutes}`;
  }
  return null;
}

function bookFromExtract(extract: TripExtract, brief: string, now: Date, id: string): Roadbook | string {
  const validated = validateExtract(extract, now, brief);
  if (!validated.ok) return "extract was rejected";
  const spec = specFromExtract(validated.value, now, validated.ask, brief);
  return buildDraftFromSpec(spec, { id, now, random: sequence() });
}

function sequence(): () => string {
  let n = 0;
  return () => `e${(n += 1)}`;
}

async function readExtractFixture<T>(name: string): Promise<T> {
  const raw = await readFile(path.join(root, "fixtures", "extract", name), "utf8");
  return JSON.parse(raw) as T;
}

function assertExtractSync(jinan: { brief: string; now: string; extract: TripExtract }, bad: {
  brief: string;
  now: string;
  cases: { name: string; extract?: TripExtract; raw?: string }[];
}, sentences: { now: string; cases: { id: string; brief: string; extract: TripExtract }[] }): string | null {
  const now = new Date(jinan.now);
  const parsed = parseBrief(JINAN_BRIEF);
  if (parsed.origin !== "上海" || parsed.destinations[0] !== "济南") {
    return `规则应读成上海到济南，得到 ${parsed.origin} -> ${parsed.destinations.join(",")}`;
  }
  const rules = buildDraft(JINAN_BRIEF, { id: "rules-jinan", now, random: sequence() });
  if (rules.city === "上海" || rules.title.startsWith("上海")) return `无密钥时仍把济南读成上海：${rules.title}`;
  if (blobHasSelfTrip(rules)) return "无密钥规则兜底出现了从上海前往上海";
  if (rules.city !== "济南" && !rules.question) return `无密钥时应是济南或追问，得到 ${rules.city}`;
  const rulesProblem = rules.city === "济南" ? assertJinanBook(rules) : null;
  if (rules.city === "济南" && rulesProblem) return `规则兜底：${rulesProblem}`;

  const around = buildDraft("从上海出发，就在上海周边玩", { id: "around", now, random: sequence() });
  if (blobHasSelfTrip(around)) return "上海周边玩出现了从上海前往上海";
  if (!around.question) return "出发地和目的地相同时应追问去哪座城市";

  const suzhouNow = new Date("2026-11-09T02:00:00Z");
  const suzhouRules = buildDraft("明天早上 8 点从上海出发去苏州，当天回", {
    id: "suzhou-rules",
    now: suzhouNow,
    random: sequence(),
  });
  const suzhouSpan = suzhouRules.items.reduce((max, item) => Math.max(max, item.dayIndex), 1);
  if (suzhouRules.city !== "苏州" || suzhouSpan !== 1) return `当天回规则应是苏州 1 天，得到 ${suzhouRules.city} ${suzhouSpan}`;
  if (blobHasSelfTrip(suzhouRules)) return "苏州当天回出现了从上海前往上海";
  const suzhouLegs = suzhouRules.items.filter((item) => item.locked && item.type === "交通");
  if (suzhouLegs.length < 2) return "当天回规则应锁上去程和返程";
  if (suzhouRules.startDate !== "2026-11-10") return `明天出发应是 2026-11-10，得到 ${suzhouRules.startDate}`;

  const zibo = parseBrief("从上海去往淄博玩两天");
  if (zibo.origin !== "上海" || zibo.destinations[0] !== "淄博") {
    return `未知城市应保留淄博，得到 ${zibo.origin} -> ${zibo.destinations.join(",")}`;
  }
  const ziboBook = buildDraft("从上海去往淄博玩两天", { id: "zibo", now, random: sequence() });
  if (ziboBook.city !== "淄博") return `淄博草稿城市 ${ziboBook.city}`;
  if (JSON.stringify(ziboBook).includes("外滩") || JSON.stringify(ziboBook).includes("西湖")) {
    return "未知城市不应抄别的城市的景点";
  }

  const validated = validateExtract(jinan.extract, now, jinan.brief);
  if (!validated.ok) return "济南抽取应通过校验";
  const modelBook = bookFromExtract(jinan.extract, jinan.brief, now, "model-jinan");
  if (typeof modelBook === "string") return modelBook;
  const modelProblem = assertJinanBook(modelBook);
  if (modelProblem) return modelProblem;
  if (modelBook.assumptions.find((item) => item.key === "city")?.inferred) return "明说的目的地不应标成推断";
  if (modelBook.assumptions.find((item) => item.key === "city")?.detail !== "从你的原话读出") {
    return "明说的目的地应注明从原话读出";
  }

  for (const item of sentences.cases) {
    const sentenceNow = new Date(sentences.now);
    const built = bookFromExtract(item.extract, item.brief, sentenceNow, item.id);
    if (typeof built === "string") return `${item.id} ${built}`;
    if (blobHasSelfTrip(built)) return `${item.id} 出现了从上海前往上海`;
    if (item.id === "taishan") {
      if (built.city !== "泰安") return `泰山应是泰安，得到 ${built.city}`;
      if (!built.items.some((entry) => entry.title.includes("泰山") && entry.priority === "必去")) return "泰山应是必去";
    }
    if (item.id === "west-lake-weekend") {
      if (built.city !== "杭州" || built.startDate !== "2026-11-14") {
        return `西湖周末应是杭州 2026-11-14，得到 ${built.city} ${built.startDate}`;
      }
      if (built.assumptions.find((entry) => entry.key === "party")?.value !== "两个人") return "周末西湖应是两个人";
    }
    if (item.id === "chengdu-meeting") {
      const span = built.items.reduce((max, entry) => Math.max(max, entry.dayIndex), 1);
      if (built.city !== "成都" || span !== 3) return `成都出差应是 3 天，得到 ${built.city} ${span}`;
      if (!built.items.some((entry) => entry.title.includes("开会") && entry.locked && entry.type === "办事")) {
        return "开会应锁定";
      }
      if (built.items.some((entry) => entry.type === "景点")) return "出差不应塞景点";
    }
    if (item.id === "suzhou-day") {
      const span = built.items.reduce((max, entry) => Math.max(max, entry.dayIndex), 1);
      if (built.city !== "苏州" || span !== 1) return `苏州当天回应是 1 天，得到 ${built.city} ${span}`;
      const legs = built.items.filter((entry) => entry.locked && entry.type === "交通");
      if (legs.length < 2) return "苏州当天回的去程和返程都应锁定";
    }
    if (item.id === "shanghai-around" && blobHasSelfTrip(built)) return "上海周边玩出现了从上海前往上海";
  }

  const badNow = new Date(bad.now);
  for (const item of bad.cases) {
    if (item.raw) {
      if (parseExtract(item.raw) != null) return `${item.name} 残缺 JSON 不应被当成抽取结果`;
      const fallback = buildDraft(bad.brief, { id: item.name, now: badNow, random: sequence() });
      if (fallback.city === "上海" || blobHasSelfTrip(fallback)) return `${item.name} 退回后仍是上海自环`;
      if (fallback.city !== "济南" && !fallback.question) return `${item.name} 应退回济南或追问`;
      continue;
    }
    if (!item.extract) return `${item.name} 缺少抽取`;
    const result = validateExtract(item.extract, badNow, bad.brief);
    if (item.name === "same-city") {
      if (result.ok) return "出发地和目的地冲突时应退回规则";
      const fallback = buildDraft(bad.brief, { id: item.name, now: badNow, random: sequence() });
      if (fallback.city === "上海" || blobHasSelfTrip(fallback)) return "相同城市的错误抽取退回后仍是上海";
      if (fallback.city !== "济南" && !fallback.question) return "相同城市的错误抽取应退回济南或追问";
      continue;
    }
    if (item.name === "dates-out-of-range") {
      if (!result.ok) {
        const fallback = buildDraft(bad.brief, { id: item.name, now: badNow, random: sequence() });
        if (fallback.city === "上海" || blobHasSelfTrip(fallback)) return "超范围日期退回后仍是上海";
        continue;
      }
      if (result.value.startDate === "2020-01-01" || result.value.endDate === "2020-01-03") {
        return "超范围日期应丢掉";
      }
      const built = buildDraftFromSpec(specFromExtract(result.value, badNow, result.ask, bad.brief), {
        id: item.name,
        now: badNow,
        random: sequence(),
      });
      if (built.startDate.startsWith("2020") || blobHasSelfTrip(built) || built.city !== "济南") {
        return `超范围日期仍写进了草稿：${built.city} ${built.startDate}`;
      }
    }
  }

  const biz: RoadbookItem = {
    id: "i_biz",
    dayIndex: 1,
    startTime: "20:10",
    durationMinutes: 90,
    title: "体检",
    place: "济南",
    lat: null,
    lng: null,
    type: "办事",
    status: "待做",
    source: { kind: "推断", note: "来自你的原话" },
    travelEstimateMinutes: 10,
    locked: false,
    priority: "可砍",
    indoor: true,
    highlight: false,
  };
  const free: RoadbookItem = { ...biz, id: "i_free", startTime: "20:00", durationMinutes: 120, title: "可砍的闲逛", type: "自由", priority: "可砍" };
  const host: Roadbook = {
    ...rules,
    id: "cut",
    city: "济南",
    startDate: "2026-11-06",
    items: [free, biz],
    patchHistory: [],
    undo: null,
  };
  const late = planLate(host, now);
  if (!late.request) return late.note;
  const shifted = applyPatch(host, { ...late.request, id: "p_cut_biz" });
  if (!shifted.ok) return shifted.error;
  if (!shifted.book.items.some((item) => item.id === "i_biz")) return "晚了 1 小时不应砍掉办事";
  if (shifted.book.items.some((item) => item.id === "i_free")) return "晚了 1 小时应先砍自由活动";
  return null;
}

async function assertExtract(): Promise<string | null> {
  const jinan = await readExtractFixture<{ brief: string; now: string; extract: TripExtract }>("extract-jinan.json");
  const bad = await readExtractFixture<{
    brief: string;
    now: string;
    cases: { name: string; extract?: TripExtract; raw?: string }[];
  }>("extract-bad.json");
  const sentences = await readExtractFixture<{ now: string; cases: { id: string; brief: string; extract: TripExtract }[] }>(
    "sentences.json",
  );
  return assertExtractSync(jinan, bad, sentences);
}

async function assertLiveExtract(): Promise<string | null> {
  const now = new Date();
  const env = readLlmEnv();
  const cases: { brief: string; check: (book: Roadbook) => string | null }[] = [
    { brief: JINAN_BRIEF, check: (book) => assertJinanBook(book) },
    {
      brief: "想去爬泰山",
      check: (book) =>
        book.city === "泰安" && book.items.some((item) => item.title.includes("泰山") && item.priority === "必去")
          ? null
          : `泰山应是泰安且必去，得到 ${book.city}`,
    },
    {
      brief: "这周末想去西湖走走，两个人",
      check: (book) => {
        if (book.city !== "杭州") return `西湖应是杭州，得到 ${book.city}`;
        if (book.assumptions.find((item) => item.key === "party")?.value !== "两个人") return "应是两个人";
        const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short" }).format(
          new Date(`${book.startDate}T04:00:00Z`),
        );
        if (weekday !== "Sat") return `周末应从周六开始，得到 ${book.startDate} ${weekday}`;
        return null;
      },
    },
    {
      brief: "下周三到周五去成都出差，周四下午 2 点开会",
      check: (book) => {
        const span = book.items.reduce((max, item) => Math.max(max, item.dayIndex), 1);
        if (span !== 3 || book.city !== "成都") return `成都出差应是 3 天，得到 ${book.city} ${span}`;
        if (!book.items.some((item) => /开会|会议/.test(item.title) && item.locked)) return "会议应锁定";
        if (book.items.some((item) => item.type === "景点")) return "出差不应塞景点";
        return null;
      },
    },
    {
      brief: "明天早上 8 点从上海出发去苏州，当天回",
      check: (book) => {
        const span = book.items.reduce((max, item) => Math.max(max, item.dayIndex), 1);
        const legs = book.items.filter((item) => item.locked && item.type === "交通");
        if (book.city !== "苏州" || span !== 1 || legs.length < 2) return `苏州当天回应锁定去程和返程，得到 ${book.city} ${span} 锁定${legs.length}`;
        return blobHasSelfTrip(book) ? "出现了从上海前往上海" : null;
      },
    },
    {
      brief: "从上海出发，就在上海周边玩",
      check: (book) => (blobHasSelfTrip(book) ? "出现了从上海前往上海" : null),
    },
  ];
  for (const item of cases) {
    const extract = await extractBrief(item.brief, now, env);
    if (!extract) return `在线抽取没有返回结构：${item.brief.slice(0, 24)}`;
    const validated = validateExtract(extract, now, item.brief);
    const book = validated.ok
      ? buildDraftFromSpec(specFromExtract(validated.value, now, validated.ask, item.brief), { id: "live", now, random: sequence() })
      : buildDraft(item.brief, { id: "live-rules", now, random: sequence() });
    if (blobHasSelfTrip(book)) return `${item.brief.slice(0, 18)} 出现了从上海前往上海`;
    const problem = item.check(book);
    if (problem) return problem;
  }
  return null;
}

function assertLlmBase(): string | null {
  const fallback = "https://api.deepseek.com/v1";
  const rejected = [
    "http://127.0.0.1/v1",
    "https://127.0.0.1/v1",
    "https://localhost/v1",
    "https://10.1.2.3/v1",
    "https://192.168.1.8/v1",
    "https://172.16.0.4/v1",
    "https://169.254.169.254/latest",
    "https://[::1]/v1",
    "https://metadata.google.internal/",
    "http://api.example.com/v1",
    "https://user:pass@api.example.com/v1",
  ];
  for (const input of rejected) {
    const got = publicHttpsBase(input, fallback);
    if (got !== fallback) return `${input} 应拒绝，得到 ${got}`;
  }
  const kept = publicHttpsBase("https://api.example.com/v1/", fallback);
  if (kept !== "https://api.example.com/v1") return `公开地址被改成 ${kept}`;
  const message = modelHttpError(502);
  if (!message.includes("502") || message.includes("{") || message.includes("：")) {
    return "模型错误不应回显响应体";
  }
  const blockedBase = resolveLlmBase("https://10.1.2.3/v1", fallback);
  if (blockedBase.ok) return "内网模型地址应拒绝，而不是改去默认接口";
  const httpBase = resolveLlmBase("http://api.example.com/v1", fallback);
  if (httpBase.ok) return "非 https 模型地址应拒绝";
  const emptyBase = resolveLlmBase("  ", fallback);
  if (!emptyBase.ok || emptyBase.baseURL !== fallback) return "没填模型地址时应使用默认接口";
  const keptBase = resolveLlmBase("https://api.example.com/v1/", fallback);
  if (!keptBase.ok || keptBase.baseURL !== "https://api.example.com/v1") return "公开模型地址应保留";
  const auth = modelHttpError(401);
  if (!auth.includes("密钥") || auth.includes("401") || auth.includes("不允许使用")) {
    return `401 应说明密钥：${auth}`;
  }
  if (!blockedModelUrlMessage.includes("这个模型地址不允许使用")) return "拦截文案应写明地址不允许使用";
  return null;
}

async function main(): Promise<void> {
  const parserError = assertParser();
  if (parserError) {
    console.error(`parser  ${parserError}`);
    process.exit(1);
  }
  if (live && !hasLlmKey()) {
    console.error("eval:live needs LLM_API_KEY (or XAI_API_KEY) in the environment or .env");
    process.exit(1);
  }

  const clarifyError = assertClarify();
  if (clarifyError) {
    console.error(`clarify  ${clarifyError}`);
    process.exit(1);
  }

  const roadbookError = assertRoadbook();
  if (roadbookError) {
    console.error(`roadbook  ${roadbookError}`);
    process.exit(1);
  }
  const phraseError = assertLocalPhrases();
  if (phraseError) {
    console.error(`phrases  ${phraseError}`);
    process.exit(1);
  }
  const tiredError = assertTiredClimb();
  if (tiredError) {
    console.error(`tired  ${tiredError}`);
    process.exit(1);
  }
  const dateError = assertUnsetDate();
  if (dateError) {
    console.error(`date  ${dateError}`);
    process.exit(1);
  }
  const extractError = await assertExtract();
  if (extractError) {
    console.error(`extract  ${extractError}`);
    process.exit(1);
  }
  console.log("  ok extract, validate, jinan draft, rule fallback");
  const baseError = assertLlmBase();
  if (baseError) {
    console.error(`llm-base  ${baseError}`);
    process.exit(1);
  }
  console.log("  ok roadbook patch, undo, late, rain, tired");

  const fixtures = await loadFixtures();
  if (fixtures.length < 10) {
    console.error(`expected at least 10 fixtures, found ${fixtures.length}`);
    process.exit(1);
  }

  console.log(live ? "路书 evals  live model" : "路书 evals  offline");
  let failed = 0;
  let sawPlan = false;
  for (const fixture of fixtures) {
    try {
      if (fixture.expect === "clarify") {
        const assessment = assessClarification(fixture.brief);
        if (!assessment.needsClarify || assessment.questions.length > 3) {
          failed += 1;
          console.log(`  x  ${fixture.id}  expected a clarify step`);
          continue;
        }
        if (assessment.questions.some((question) => question.assumedId === "arrive")) {
          failed += 1;
          console.log(`  x  ${fixture.id}  defaulted a clock to arrival`);
          continue;
        }
        console.log(`  ok ${fixture.id}  clarify ${assessment.questions.map((question) => question.id).join(",")}`);
        continue;
      }
      const gate = assessClarification(fixture.brief);
      if (gate.needsClarify) {
        failed += 1;
        console.log(
          `  x  ${fixture.id}  confirmed brief still needs clarify: ${gate.questions.map((question) => question.id).join(",")}`,
        );
        continue;
      }
      const result = await runTravelAgent(fixture.brief, {
        llm: live ? "auto" : "off",
        tools: live ? "auto" : "stub",
      });
      sawPlan = true;
      const problem = checkResult(result, fixture.checks) ?? checkWeather(result, live);
      if (problem) {
        failed += 1;
        console.log(`  x  ${fixture.id}  ${problem}`);
      } else {
        const days = result.variants[0]?.days.length ?? 0;
        console.log(
          `  ok ${fixture.id}  ${days} days, ${result.variants.length} plans, ${result.usage.toolCalls} tools, ${result.mode}`,
        );
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : "unknown error";
      console.log(`  x  ${fixture.id}  threw: ${message}`);
    }
  }
  if (!failed && sawPlan && !live) {
    const sample = await runTravelAgent("下周末两个人从上海去苏州，预算两千左右，想看园林也想吃本地菜。", {
      llm: "off",
      tools: "stub",
    });
    const base = sample.variants[0];
    if (!base) {
      console.error("follow-up  sample plan missing");
      process.exit(1);
    }
    const hotel = applyPlanFollowUp(base, sample.spec, "帮我比较一下住哪，找酒店区域");
    const hotelBody = hotel.variant.supplements?.map((item) => item.body).join("\n") ?? "";
    if (hotel.variant.id !== base.id || !hotel.variant.supplements?.some((item) => item.kind === "hotel")) {
      console.error("follow-up  hotel section was not appended on the same plan");
      process.exit(1);
    }
    if (!hotelBody.includes("不代订") || /立即预订|去付款|马上下单/.test(hotelBody)) {
      console.error("follow-up  hotel copy booked or charged");
      process.exit(1);
    }
    const taxi = applyPlanFollowUp(hotel.variant, sample.spec, "景点之间打车怎么走");
    const taxiBody = taxi.variant.supplements?.find((item) => item.kind === "taxi")?.body ?? "";
    if (!taxiBody.includes("不叫车")) {
      console.error("follow-up  taxi section missing");
      process.exit(1);
    }
    const revised = applyPlanFollowUp(base, sample.spec, "把第1天改到下午再出门");
    const firstTime = revised.variant.days[0]?.items[0]?.time ?? "";
    if (firstTime !== "下午") {
      console.error(`follow-up  expected afternoon start, got ${firstTime}`);
      process.exit(1);
    }
    const resolved = applyClarification("周五2点高铁去济南", {
      "transport-time": "depart",
      duration: "2",
      party: "2",
    });
    const planned = await runTravelAgent(resolved, { llm: "off", tools: "stub" });
    const planProblem = checkResult(planned, { minDays: 2, keywords: ["济南"] });
    if (planProblem) {
      console.error(`clarify-plan  ${planProblem}`);
      process.exit(1);
    }
    const assumptions = planned.variants.flatMap((variant) => variant.assumptions).join("\n");
    if (!assumptions.includes("不是到达")) {
      console.error("clarify-plan  did not record departure instead of arrival");
      process.exit(1);
    }
    console.log("  ok follow-up and confirmed jinan plan");
  }
  if (failed === 0 && live) {
    const liveExtractError = await assertLiveExtract();
    if (liveExtractError) {
      console.error(`extract-live  ${liveExtractError}`);
      process.exit(1);
    }
    console.log("  ok live extract sentences");
  }
  console.log(`${fixtures.length - failed}/${fixtures.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
