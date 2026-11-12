import { blockedModelUrlMessage, modelHttpError, publicHttpsBase, readLlmEnv, resolveLlmBase } from "@lushu/llm";
import { config } from "dotenv";
import { spawn } from "node:child_process";
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
  addDays,
  applyPatch,
  applyRoadbookStyle,
  buildDraft,
  buildDraftFromSpec,
  checklistRowRetired,
  citeRetrievedSights,
  classifyBookKey,
  chooseItemSwap,
  cityTemplateNames,
  describeItemMenu,
  describeStyles,
  factMark,
  forecastDaysThrough,
  isWrapPunctuation,
  wrapMeasuredText,
  formatTime,
  normalizeRoadbook,
  normalizeWeatherQuery,
  opsFromUnknown,
  parseTime,
  normalizeRoadbookUndo,
  planAssumptionEdit,
  planItemDelete,
  planItemMove,
  planItemSwap,
  planItemUnlock,
  planLate,
  planLockMust,
  planMessage,
  planRain,
  planTired,
  setChecklistChecked,
  shareView,
  shanghaiDate,
  shanghaiMinutes,
  STYLE_CONFIRM,
  specForQuestion,
  specFromExtract,
  specFromRules,
  summarizeChanges,
  snapForTripDay,
  undoLast,
  UNDO_STACK_LIMIT,
  verifyCue,
  weatherMark,
  whyForItem,
  type Roadbook,
  type RoadbookItem,
} from "@lushu/agent/roadbook";
import {
  extractBrief,
  modelPatchExamples,
  modelPatchSystem,
  parseExtract,
  proposeModelPatch,
  validateExtract,
  type TripExtract,
} from "@lushu/agent/roadbook-server";

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
/**
 * Live fixtures used to run 4 at a time (three waves for 11 cases) and the extract
 * sentences then ran one by one. That tail pushed the full suite past ~175s.
 * One wave of fixtures and the same pool for extract keeps the suite inside that budget.
 * Offline `pnpm eval` stays serial.
 */
const LIVE_CONCURRENCY = 11;

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

/** 2000, 2,000, ¥2000 and 两千 are the same stated budget. */
function budgetMentioned(notes: string, amount: string): boolean {
  const target = Number(amount);
  if (!Number.isFinite(target)) return notes.includes(amount);
  if (notes.replace(/[,，\s]/g, "").includes(String(target))) return true;
  const tokens = notes.match(/[零〇一二两三四五六七八九十百千万]+/g) ?? [];
  return tokens.some((token) => parseZhNumber(token) === target);
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
    if (!budgetMentioned(notes, checks.budgetIncludes)) {
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
  if (book.patchHistory.length < 1 || book.undo.length > 0) return "草稿应记下生成补丁且还不能撤销";

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
  const restoredLake = undone.book.items.find((item) => item.id === lake.id);
  if (restoredLake?.startTime !== lake.startTime) {
    return "撤销后应回到上一份时间";
  }
  if (!restoredLake.highlight) return "撤销后刚改应跟着被退回的项";
  if (undone.book.undo.length > 0) return "撤销后不应再叠一层撤销";

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
  const rainRow = rained.book.verifyChecklist.find((item) => item.text.includes("西湖是户外，下雨要不要去"));
  if (!rainRow) return "下雨应把必去户外写进核实清单";
  if (rainRow.itemId !== lake.id) return `下雨清单应关联西湖，得到 ${rainRow.itemId ?? "无"}`;
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

function rangesOverlap(a: RoadbookItem, b: RoadbookItem): boolean {
  if (a.dayIndex !== b.dayIndex || a.id === b.id) return false;
  const start = parseTime(a.startTime);
  const other = parseTime(b.startTime);
  if (start == null || other == null) return false;
  return start < other + b.durationMinutes && start + a.durationMinutes > other;
}

function overlappingMeal(book: Roadbook, titlePart: string): string | null {
  const sight = book.items.find((item) => item.type === "景点" && item.title.includes(titlePart));
  if (!sight) return `缺少${titlePart}`;
  const meal = book.items.find((item) => item.type === "餐" && rangesOverlap(sight, item));
  if (!meal) return null;
  return `${sight.title} ${sight.startTime}（${sight.durationMinutes} 分钟）与 ${meal.title} ${meal.startTime} 重叠`;
}

function assertNamedSight(book: Roadbook, titlePart: string): string | null {
  const sight = book.items.find((item) => item.type === "景点" && item.title.includes(titlePart));
  if (!sight || sight.priority !== "必去") return `${titlePart}应是必去`;
  const note = `${sight.note ?? ""}`;
  if (!note.includes("你点名要去的地方")) return `${titlePart}应写你点名要去的地方：${note}`;
  if (/通用模板|地点是推断/.test(`${sight.note ?? ""} ${sight.source.note ?? ""}`)) {
    return `${titlePart}不应标成通用模板`;
  }
  return null;
}

function assertReturnTo(book: Roadbook, origin: string): string | null {
  const back = book.items.find((item) => {
    if (item.type !== "交通") return false;
    if (item.title === `返回${origin}` || item.title.includes(`到达${origin}`)) return true;
    return item.title.includes(`前往${origin}`) && !item.title.includes(`前往${book.city}`);
  });
  if (!back) return `应有回到${origin}的交通`;
  return null;
}

function assertStatedTaishan(book: Roadbook): string | null {
  const shape = assertTaishanShape(book);
  if (shape) return shape;
  const climb = book.items.find((item) => item.type === "景点" && item.title.includes("泰山"));
  if (!climb) return "缺少泰山";
  const blob = `${climb.note ?? ""}${climb.source.note ?? ""}`;
  if (climb.startTime === "07:00") {
    if (!climb.locked) return "07:00 的泰山应锁定";
    if (climb.source.kind !== "实测") return `07:00 应标实测，得到 ${climb.source.kind}`;
    if (!blob.includes("来自你的原话")) return `07:00 应注明来自你的原话：${blob}`;
    return null;
  }
  if (climb.locked) return `泰山放到 ${climb.startTime} 后不应锁定`;
  if (blob.includes("来自你的原话")) return "改点后不应再写来自你的原话";
  if (!blob.includes("时间推断")) return "改点后应标时间推断";
  return null;
}

function assertWuzhenArrival(book: Roadbook): string | null {
  if (book.city !== "嘉兴") return `乌镇应是嘉兴，得到 ${book.city}`;
  const named = assertNamedSight(book, "乌镇");
  if (named) return named;
  const overlap = overlappingMeal(book, "乌镇");
  if (overlap) return overlap;
  const arrival = book.items.find((item) => item.type === "交通" && item.startTime === "15:00");
  if (!arrival?.locked) return "下午3点到应写在锁定的 15:00 交通上";
  const sight = book.items.find((item) => item.type === "景点" && item.title.includes("乌镇"));
  if (!sight) return "缺少乌镇";
  if (sight.startTime === "15:00") return "3点到不应写成乌镇的钟点";
  if (sight.locked && `${sight.note ?? ""}${sight.source.note ?? ""}`.includes("来自你的原话")) {
    return "乌镇不应锁成到达钟点";
  }
  return null;
}

function assertTaishanShape(book: Roadbook, strictStart = false): string | null {
  if (book.city !== "泰安") return `泰山应是泰安，得到 ${book.city}`;
  const climbs = book.items.filter((item) => item.type === "景点" && /泰山|爬山|登山/.test(item.title));
  if (climbs.length !== 1) {
    return `泰山应只出现一次，得到 ${climbs.map((item) => `${item.title}/${item.durationMinutes}`).join("、") || "无"}`;
  }
  const climb = climbs[0];
  if (!climb || !climb.title.includes("泰山") || climb.priority !== "必去") {
    return `泰山应是必去，得到 ${climb?.title} ${climb?.priority}`;
  }
  if (climb.durationMinutes < 300 || climb.durationMinutes > 480) {
    return `泰山应为 5–8 小时，得到 ${climb.durationMinutes}`;
  }
  const start = parseTime(climb.startTime);
  if (start == null || start < 7 * 60 || start > 9 * 60 + 30) {
    return `泰山应在早上出发，得到 ${climb.startTime}`;
  }
  if (strictStart && climb.startTime !== "07:40") return `泰山应在 07:40，得到 ${climb.startTime}`;
  if (/通用模板/.test(`${climb.note ?? ""}${climb.source.note ?? ""}`)) return "泰山不应是通用模板";
  if (book.items.some((item) => item.type === "景点" && /^(爬泰山|爬山|登山)$/.test(item.title))) {
    return "不应再单列爬泰山或爬山";
  }
  return null;
}

function assertJinanBook(book: Roadbook, expectedStart = "2026-11-06"): string | null {
  if (book.city !== "济南") return `目的地应是济南，得到 ${book.city} / ${book.title}`;
  if (book.title.includes("上海")) return `标题不应是上海：${book.title}`;
  if (blobHasSelfTrip(book)) return "出现了从上海前往上海";
  if (book.startDate !== expectedStart) return `出发日应是 ${expectedStart}，得到 ${book.startDate}`;
  const days = book.items.reduce((max, item) => Math.max(max, item.dayIndex), 1);
  if (days !== 2) return `应是 2 天，得到 ${days}`;
  if (book.assumptions.find((item) => item.key === "days")?.value !== "2 天") return "天数标签应是 2 天";
  const locked = book.items.filter((item) => item.locked);
  if (!locked.some((item) => item.title === "从上海前往济南" && item.type === "交通")) return "去程未锁定";
  if (!locked.some((item) => item.dayIndex === 2 && item.type === "交通" && item.title.includes("济南") && item.title.includes("上海"))) {
    return "返程未锁定";
  }
  const checkup = book.items.find((item) => item.title.includes("体检"));
  if (!checkup || checkup.type !== "办事" || checkup.priority !== "必去") return "体检应为必去的办事";
  if (checkup.locked) return "没写钟点的体检不应锁定";
  if (!`${checkup.note ?? ""} ${checkup.source.note ?? ""}`.includes("时间推断")) return "没写钟点的体检应标时间推断";
  if (checkup.source.kind !== "推断") return `没写钟点的体检来源仍是推断，得到 ${checkup.source.kind}`;
  if (factMark(checkup).needsVerify) return "用户说的体检不应显示成需要你核实";
  if (checkup.startTime !== "08:00") return `体检应先放在 08:00，得到 ${checkup.startTime}`;
  if (!checkup.note?.includes(checkup.startTime)) return `体检备注应写实际时间 ${checkup.startTime}：${checkup.note}`;
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
  if (book.verifyChecklist.some((item) => item.text.includes("开放时间") || item.text.includes("闭馆"))) {
    return "办事核实清单不应有开放时间、闭馆日";
  }
  if (!book.items.some((item) => item.dayIndex === 1 && item.title.includes("回酒店"))) return "第 1 天应有回酒店";
  const ride = book.items.find((item) => item.title === "从上海前往济南");
  if (!ride || ride.durationMinutes <= 180 || ride.estimateSource !== "推断") {
    return `济沪高铁应长于 180 分钟，得到 ${ride?.durationMinutes}`;
  }
  const back = book.items.find((item) => item.dayIndex === 2 && item.type === "交通" && item.title.includes("济南") && item.title.includes("上海"));
  if (!back || back.durationMinutes !== ride.durationMinutes) {
    return `返程应沿用去程高铁 ${ride.durationMinutes} 分钟，得到 ${back?.durationMinutes}`;
  }
  if (!back.locked || back.startTime !== "16:30") return `写了钟点的返程应锁定在 16:30，得到 ${back.startTime} locked=${back.locked}`;
  const statedBlob = `${back.note ?? ""}${back.source.note ?? ""}`;
  if (back.source.kind !== "实测") return `写了返程钟点应标实测，得到 ${back.source.kind}`;
  if (!statedBlob.includes("来自你的原话")) return `写了返程钟点应标来自你的原话：${statedBlob}`;
  const station = book.items.find((item) => item.title === "去车站");
  if (!station || station.dayIndex !== 2 || station.startTime !== "15:30") {
    return `去车站应在返程前 15:30，得到 ${station?.startTime}`;
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
  if (!around.question || around.question.prompt !== "去哪座城市？") return "出发地和目的地相同时应追问去哪座城市";
  if (around.items.length > 0) return "只追问时不应先编行程";

  const suzhouNow = new Date("2026-11-09T02:00:00Z");
  const suzhouRules = buildDraft("明天早上 8 点从上海出发去苏州，当天回", {
    id: "suzhou-rules",
    now: suzhouNow,
    random: sequence(),
  });
  const suzhouSpan = suzhouRules.items.reduce((max, item) => Math.max(max, item.dayIndex), 1);
  if (suzhouRules.city !== "苏州" || suzhouSpan !== 1) return `当天回规则应是苏州 1 天，得到 ${suzhouRules.city} ${suzhouSpan}`;
  if (blobHasSelfTrip(suzhouRules)) return "苏州当天回出现了从上海前往上海";
  const suzhouLegs = suzhouRules.items.filter((item) => item.type === "交通" && (item.title.startsWith("从") || item.title.startsWith("返回")));
  const suzhouOut = suzhouLegs.find((item) => item.title.includes("前往苏州"));
  const suzhouReturn = suzhouLegs.find((item) => item.id !== suzhouOut?.id && (item.title.startsWith("返回") || item.title.includes("上海")));
  if (!suzhouOut?.locked) return "当天回规则应锁上写了钟点的去程";
  if (!suzhouReturn) return "当天回规则应有返程";
  if (!suzhouReturn.locked && !`${suzhouReturn.note ?? ""}${suzhouReturn.source.note ?? ""}`.includes("时间推断")) {
    return "没写钟点的返程应标时间推断";
  }
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
      const shape = assertTaishanShape(built, true);
      if (shape) return shape;
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
      const outbound = built.items.find((entry) => entry.type === "交通" && entry.title.includes("前往苏州"));
      const back = built.items.find((entry) => entry.title === "返回上海");
      if (!outbound?.locked || outbound.startTime !== "08:00") return "苏州当天回的去程应锁在 08:00";
      if (!back || back.locked || back.startTime !== "18:00") {
        return `当天回没写返程钟点，返程应是未锁定的 18:00，得到 ${back?.startTime} locked=${back?.locked}`;
      }
      const backBlob = `${back.note ?? ""}${back.source.note ?? ""}`;
      if (!backBlob.includes("时间推断") || backBlob.includes("来自你的原话")) return `当天回返程应标时间推断：${backBlob}`;
    }
    if (item.id === "shanghai-around") {
      if (blobHasSelfTrip(built)) return "上海周边玩出现了从上海前往上海";
      if (built.items.length > 0 || built.question?.prompt !== "去哪座城市？") return "上海周边应只追问，行程项为空";
    }
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

  const badTai = bookFromExtract(
    {
      kind: "旅游",
      origin: null,
      destination: { city: "泰山", area: null },
      startDate: null,
      endDate: null,
      party: null,
      outbound: null,
      inbound: null,
      fixed: [{ date: null, time: null, endTime: null, title: "爬泰山", place: "泰山", type: "景点" }],
      lodging: null,
      interests: ["爬山"],
      pace: null,
      budget: null,
      missing: [],
    },
    "想去爬泰山",
    now,
    "tai-fixed",
  );
  if (typeof badTai === "string") return badTai;
  const badTaiShape = assertTaishanShape(badTai, true);
  if (badTaiShape) return `未写钟点的爬泰山：${badTaiShape}`;
  if (badTai.items.filter((item) => item.type === "景点" && item.durationMinutes <= 120 && /爬|山/.test(item.title)).length > 0) {
    return "未写钟点的爬泰山不应再排 90 分钟短行程";
  }

  const badWuzhen = bookFromExtract(
    {
      kind: "旅游",
      origin: "杭州",
      destination: { city: "乌镇", area: null },
      startDate: "2026-11-14",
      endDate: null,
      party: null,
      outbound: null,
      inbound: null,
      fixed: [],
      lodging: null,
      interests: [],
      pace: null,
      budget: null,
      missing: [],
    },
    "周六从杭州去乌镇",
    now,
    "wuzhen-city",
  );
  if (typeof badWuzhen === "string") return badWuzhen;
  if (badWuzhen.city !== "嘉兴") return `把乌镇当城市时应改成嘉兴，得到 ${badWuzhen.city}`;
  const badWuzhenNamed = assertNamedSight(badWuzhen, "乌镇");
  if (badWuzhenNamed) return `把乌镇当城市：${badWuzhenNamed}`;
  const badWuzhenBack = assertReturnTo(badWuzhen, "杭州");
  if (badWuzhenBack) return `把乌镇当城市：${badWuzhenBack}`;
  const badWuzhenOverlap = overlappingMeal(badWuzhen, "乌镇");
  if (badWuzhenOverlap) return badWuzhenOverlap;

  const anchoredWuzhen = bookFromExtract(
    {
      kind: "旅游",
      origin: "杭州",
      destination: { city: "嘉兴", area: null },
      startDate: "2026-11-14",
      endDate: "2026-11-16",
      party: null,
      outbound: { date: "2026-11-14", time: null, mode: null, from: "杭州", to: "嘉兴" },
      inbound: null,
      fixed: [],
      lodging: null,
      interests: ["乌镇"],
      pace: null,
      budget: null,
      missing: [],
    },
    "周六从杭州去乌镇",
    now,
    "wuzhen-anchored",
  );
  if (typeof anchoredWuzhen === "string") return anchoredWuzhen;
  if (anchoredWuzhen.city !== "嘉兴") return `带去程的乌镇应是嘉兴，得到 ${anchoredWuzhen.city}`;
  const anchoredNamed = assertNamedSight(anchoredWuzhen, "乌镇");
  if (anchoredNamed) return `带去程的乌镇：${anchoredNamed}`;
  const anchoredBack = assertReturnTo(anchoredWuzhen, "杭州");
  if (anchoredBack) return `带去程的乌镇：${anchoredBack}`;
  const anchoredOut = anchoredWuzhen.items.find((item) => item.type === "交通" && item.title.includes("前往嘉兴"));
  if (!anchoredOut) return "带去程的乌镇应保留杭州到嘉兴";
  const anchoredOverlap = overlappingMeal(anchoredWuzhen, "乌镇");
  if (anchoredOverlap) return anchoredOverlap;

  const arrivalMisread = bookFromExtract(
    {
      kind: "旅游",
      origin: null,
      destination: { city: "嘉兴", area: null },
      startDate: "2026-11-14",
      endDate: null,
      party: null,
      outbound: { date: "2026-11-14", time: "15:00", mode: null, from: null, to: "嘉兴" },
      inbound: null,
      fixed: [{ date: "2026-11-14", time: "15:00", endTime: null, title: "乌镇", place: "乌镇", type: "景点" }],
      lodging: null,
      interests: [],
      pace: null,
      budget: null,
      missing: [],
    },
    "周六去乌镇，下午3点到",
    now,
    "wuzhen-arrive-misread",
  );
  if (typeof arrivalMisread === "string") return arrivalMisread;
  const arrivalMisreadProblem = assertWuzhenArrival(arrivalMisread);
  if (arrivalMisreadProblem) return `模型把到达写成景点：${arrivalMisreadProblem}`;

  const droppedClock = bookFromExtract(
    {
      kind: "旅游",
      origin: null,
      destination: { city: "泰安", area: null },
      startDate: "2026-11-07",
      endDate: null,
      party: null,
      outbound: null,
      inbound: null,
      fixed: [],
      lodging: null,
      interests: ["泰山"],
      pace: null,
      budget: null,
      missing: [],
    },
    "明天早上7点去爬泰山",
    now,
    "tai-clock-dropped",
  );
  if (typeof droppedClock === "string") return droppedClock;
  const droppedShape = assertStatedTaishan(droppedClock);
  if (droppedShape) return `模型漏了泰山钟点：${droppedShape}`;

  const keptClock = bookFromExtract(
    {
      kind: "旅游",
      origin: null,
      destination: { city: "泰安", area: null },
      startDate: "2026-11-07",
      endDate: null,
      party: null,
      outbound: null,
      inbound: null,
      fixed: [{ date: "2026-11-07", time: "07:00", endTime: null, title: "爬泰山", place: "泰山", type: "景点" }],
      lodging: null,
      interests: ["爬山"],
      pace: null,
      budget: null,
      missing: [],
    },
    "明天早上7点去爬泰山",
    now,
    "tai-clock-fixed",
  );
  if (typeof keptClock === "string") return keptClock;
  const keptShape = assertStatedTaishan(keptClock);
  if (keptShape) return `写了钟点的爬泰山：${keptShape}`;
  if (keptClock.items.some((item) => item.type === "景点" && item.durationMinutes <= 120 && /泰山|爬|山/.test(item.title))) {
    return "写了钟点的泰山不应再用 90 分钟的固定时长";
  }

  const movedClock = bookFromExtract(
    {
      kind: "办事",
      origin: null,
      destination: { city: "济南", area: null },
      startDate: "2026-11-07",
      endDate: "2026-11-07",
      party: null,
      outbound: null,
      inbound: null,
      fixed: [
        { date: "2026-11-07", time: "07:00", endTime: null, title: "体检", place: null, type: "办事" },
        { date: "2026-11-07", time: "07:00", endTime: null, title: "开会", place: null, type: "办事" },
      ],
      lodging: null,
      interests: [],
      pace: null,
      budget: null,
      missing: [],
    },
    "明天早上7点在济南体检，早上7点开会",
    now,
    "two-clocks",
  );
  if (typeof movedClock === "string") return movedClock;
  const keptEarly = movedClock.items.find((item) => item.type === "办事" && item.startTime === "07:00");
  const movedEarly = movedClock.items.find((item) => item.type === "办事" && item.startTime !== "07:00");
  if (!keptEarly?.locked || !`${keptEarly.note ?? ""}${keptEarly.source.note ?? ""}`.includes("来自你的原话")) {
    return "放得下的 07:00 应锁定并写来自你的原话";
  }
  if (!movedEarly) return "重叠的 07:00 应挪开";
  const movedBlob = `${movedEarly.note ?? ""}${movedEarly.source.note ?? ""}`;
  if (movedEarly.locked || movedBlob.includes("来自你的原话") || !movedBlob.includes("时间推断")) {
    return `挪点后不应锁定或写成原话：${movedEarly.title} ${movedEarly.startTime} ${movedBlob}`;
  }

  const clockedPalace = bookFromExtract(
    {
      kind: "旅游",
      origin: null,
      destination: { city: "北京", area: null },
      startDate: "2026-11-10",
      endDate: "2026-11-10",
      party: null,
      outbound: null,
      inbound: null,
      fixed: [{ date: "2026-11-10", time: "14:00", endTime: null, title: "故宫", place: "东城", type: "景点" }],
      lodging: null,
      interests: ["故宫"],
      pace: null,
      budget: null,
      missing: [],
    },
    "下午两点去故宫",
    now,
    "palace-clock",
  );
  if (typeof clockedPalace === "string") return clockedPalace;
  const palaces = clockedPalace.items.filter((item) => item.type === "景点" && item.title.includes("故宫"));
  if (palaces.length !== 1 || palaces[0]?.startTime !== "14:00" || !palaces[0].locked) {
    return `写了钟点的故宫应只保留 14:00，得到 ${palaces.map((item) => `${item.startTime}/${item.durationMinutes}`).join("、")}`;
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
    undo: [],
  };
  const late = planLate(host, now);
  if (!late.request) return late.note;
  const shifted = applyPatch(host, { ...late.request, id: "p_cut_biz" });
  if (!shifted.ok) return shifted.error;
  if (!shifted.book.items.some((item) => item.id === "i_biz")) return "晚了 1 小时不应砍掉办事";
  if (shifted.book.items.some((item) => item.id === "i_free")) return "晚了 1 小时应先砍自由活动";
  return null;
}

function endsByEvening(book: Roadbook, day: number): boolean {
  return book.items.some((item) => {
    if (item.dayIndex !== day) return false;
    const start = parseTime(item.startTime);
    if (start == null) return false;
    return start >= 17 * 60 || start + item.durationMinutes >= 18 * 60;
  });
}

function assertQaRound2(): string | null {
  const now = new Date("2026-11-09T01:00:00.000Z");
  let n = 0;
  const random = () => `q${(n += 1)}`;
  const jinan = buildDraft(JINAN_BRIEF, { id: "qa-jinan", now, random });
  if (jinan.startDate !== "2026-11-09") return `济南出发日应是 2026-11-09，得到 ${jinan.startDate}`;
  const shape = assertJinanBook({ ...jinan, startDate: "2026-11-06" });
  if (shape && !shape.includes("出发日")) return shape;
  const checkup = jinan.items.find((item) => item.title.includes("体检"));
  if (!checkup || checkup.locked || checkup.priority !== "必去") return "济南体检应必去且不锁定";
  const moved = planMessage(jinan, "把体检改到7点半", random, now);
  if (!moved.request) return moved.note || "把体检改到7点半没有生效";
  const movedBook = applyPatch(jinan, { ...moved.request, id: "p_checkup" });
  if (!movedBook.ok) return movedBook.error;
  const checkupAt = movedBook.book.items.find((item) => item.id === checkup.id);
  if (checkupAt?.startTime !== "07:30") return `体检应改到 07:30，得到 ${checkupAt?.startTime}`;
  if (checkupAt.source.kind !== "实测" || checkupAt.source.note !== "你改的时间") {
    return `改过的体检应标实测和你改的时间，得到 ${checkupAt.source.kind} ${checkupAt.source.note}`;
  }
  if (!checkupAt?.note?.includes("07:30") || checkupAt.note.includes("08:00")) {
    return `体检备注应改成 07:30，得到 ${checkupAt?.note}`;
  }

  const tuesday = new Date("2026-11-10T01:30:00.000Z");
  const late = planLate(jinan, tuesday);
  if (!late.request) return late.note || "晚了 1 小时没有计划";
  const lateBook = applyPatch(jinan, { ...late.request, id: "p_late_station" });
  if (!lateBook.ok) return lateBook.error;
  const station = lateBook.book.items.find((item) => item.title === "去车站");
  if (station?.startTime !== "15:30") return `去车站应仍在 15:30，得到 ${station?.startTime}`;
  const afterStation = lateBook.book.items.filter((item) => {
    if (item.title === "去车站" || item.locked) return false;
    const start = parseTime(item.startTime);
    return item.dayIndex === 2 && start != null && start > parseTime("15:30")!;
  });
  if (afterStation.length > 0) return `去车站之后不该再排：${afterStation.map((item) => item.title).join("、")}`;

  const retimed = planMessage(jinan, "把返程改到18:00", random, now);
  if (!retimed.request) return retimed.note || "把返程改到18:00没有生效";
  const retimedBook = applyPatch(jinan, { ...retimed.request, id: "p_return" });
  if (!retimedBook.ok) return retimedBook.error;
  const stationLater = retimedBook.book.items.find((item) => item.title === "去车站");
  const rideBack = retimedBook.book.items.find((item) => item.dayIndex === 2 && item.type === "交通" && item.title.includes("上海"));
  if (rideBack?.startTime !== "18:00" || !rideBack.locked) return `返程应改到 18:00 并保持锁定，得到 ${rideBack?.startTime}`;
  if (stationLater?.startTime !== "17:00") return `去车站应跟着到 17:00，得到 ${stationLater?.startTime}`;

  for (const text of ["改成3天", "改成1天"]) {
    const plan = planMessage(jinan, text, random, now);
    if (plan.request) return `${text} 不应改行程`;
    if (plan.note !== "返程已锁定在第 2 天，要先改返程吗？") return `${text} 的提示是「${plan.note}」`;
  }

  const warm = buildDraft("想去个暖和的地方", { id: "warm", now, random });
  if (warm.question?.prompt !== "去哪座城市？" || warm.items.length > 0) return "想去个暖和的地方应只追问，行程项为空";
  const asked = buildDraftFromSpec(specForQuestion("想去个暖和的地方", "去哪座城市？"), { id: "warm-model", now, random });
  if (asked.question?.prompt !== "去哪座城市？" || asked.items.length > 0) return "模型追问应生成空草稿";

  const xining = buildDraft("明天从北京坐飞机到西宁，玩3天", { id: "xining", now, random });
  if (xining.city !== "西宁") return `西宁被读成 ${xining.city} / ${xining.title}`;
  if (xining.items.length === 0) return "西宁应排出行程";
  for (const day of [1, 2, 3]) {
    if (!endsByEvening(xining, day)) return `西宁第 ${day} 天没有排到晚上`;
    if (!xining.items.some((item) => item.dayIndex === day && item.type === "景点")) {
      return `西宁第 ${day} 天没有景点`;
    }
  }
  const citedWalk = citeRetrievedSights(
    xining.items,
    { title: "中心城区步行攻略：西宁三日游", url: "https://example.com/xining-walk" },
    now.toISOString(),
  );
  const walk = citedWalk.find((item) => item.title === "中心城区步行");
  if (!walk || walk.source.kind !== "推断" || walk.source.url) return "模板景点应保持推断，不挂检索";
  if (`${walk.source.note ?? ""}${walk.note ?? ""}`.includes("攻略")) return "模板景点不应挂检索标题";
  const west = buildDraft("今天去西湖两天，两个人", { id: "cite-west", now, random });
  const citedLake = citeRetrievedSights(
    west.items,
    { title: "西湖开放时间与门票", url: "https://example.com/xihu" },
    now.toISOString(),
  );
  const lakeCited = citedLake.find((item) => item.title === "西湖");
  if (lakeCited?.source.kind !== "检索" || lakeCited.source.note !== "西湖开放时间与门票" || !lakeCited.source.url || !lakeCited.source.fetchedAt) {
    return `西湖应标检索来源和取数时间，得到 ${lakeCited?.source.kind} ${lakeCited?.source.note} ${lakeCited?.source.fetchedAt ?? ""}`;
  }
  if (factMark(lakeCited, now).unavailable || factMark(lakeCited, now).stale) return "刚检索的西湖不应过时或暂不可用";
  const unrelated = citeRetrievedSights(
    west.items,
    { title: "一篇不相关的文章", url: "https://example.com/other" },
    now.toISOString(),
  );
  if (unrelated.find((item) => item.title === "西湖")?.source.kind !== "推断") return "对不上景点名的检索不能改来源";
  const flight = xining.items.find((item) => item.title.includes("北京") && item.title.includes("西宁"));
  if (!flight) return "西宁去程缺失";
  if (flight.locked || flight.priority !== "必去") return "没写钟点的去程应必去且不锁定";
  if (!`${flight.note ?? ""}${flight.source.note ?? ""}`.includes("时间推断")) return "没写钟点的去程应标时间推断";

  const wuzhen = buildDraft("周六从杭州去乌镇", { id: "wuzhen", now, random });
  if (wuzhen.startDate !== "2026-11-14") return `周六应从 2026-11-14 开始，得到 ${wuzhen.startDate}`;
  if (wuzhen.city !== "嘉兴") return `乌镇应是嘉兴，得到 ${wuzhen.city}`;
  const wuzhenNamed = assertNamedSight(wuzhen, "乌镇");
  if (wuzhenNamed) return wuzhenNamed;
  const wuzhenBack = assertReturnTo(wuzhen, "杭州");
  if (wuzhenBack) return wuzhenBack;
  const wuzhenOverlap = overlappingMeal(wuzhen, "乌镇");
  if (wuzhenOverlap) return wuzhenOverlap;
  const wuzhenArrive = buildDraft("周六去乌镇，下午3点到", { id: "wuzhen-arrive", now, random });
  const wuzhenArriveProblem = assertWuzhenArrival(wuzhenArrive);
  if (wuzhenArriveProblem) return wuzhenArriveProblem;
  const statedClimb = buildDraft("明天早上7点去爬泰山", { id: "tai-clock", now, random });
  const statedClimbProblem = assertStatedTaishan(statedClimb);
  if (statedClimbProblem) return statedClimbProblem;
  const flightOnly = buildDraft("坐飞机到西宁", { id: "xining-short", now, random });
  if (flightOnly.city !== "西宁" || flightOnly.items.length === 0) return `坐飞机到西宁应排出西宁，得到 ${flightOnly.city}`;
  if (flightOnly.question) return "坐飞机到西宁不应只追问";
  if (!flightOnly.items.some((item) => item.dayIndex === 3 && item.type === "景点")) return "坐飞机到西宁的第 3 天应有景点";
  const luoyang = buildDraft("下周去洛阳", { id: "luoyang", now, random });
  if (luoyang.startDate !== "2026-11-16") return `下周应从 2026-11-16 开始，得到 ${luoyang.startDate}`;
  const when = luoyang.assumptions.find((item) => item.key === "when");
  if (!when?.inferred) return "下周的日期标签应标推断";

  const chengdu = buildDraft("下周三到周五去成都出差，周四下午 2 点开会", { id: "chengdu", now, random });
  const meeting = chengdu.items.find((item) => item.title.includes("开会"));
  if (chengdu.city !== "成都" || !meeting || meeting.startTime !== "14:00" || meeting.type !== "办事") {
    return `成都开会应在 14:00，得到 ${chengdu.city} ${meeting?.startTime} 第${meeting?.dayIndex}天`;
  }
  if (chengdu.startDate !== "2026-11-18") return `成都出差应从 2026-11-18 开始，得到 ${chengdu.startDate}`;
  if (meeting.dayIndex !== 2) return `开会应在 2026-11-19 对应的第 2 天，得到第 ${meeting.dayIndex} 天`;
  if (meeting.source.kind !== "实测" || !`${meeting.note ?? ""}${meeting.source.note ?? ""}`.includes("来自你的原话")) {
    return `写了钟点的开会应标实测，得到 ${meeting.source.kind} ${meeting.source.note}`;
  }
  if (factMark(meeting).needsVerify) return "用户说的开会不应显示成需要你核实";
  const meetingMove = planMessage(chengdu, "把开会改到15:00", random, now);
  if (!meetingMove.request) return meetingMove.note || "把开会改到15:00没有生效";
  const meetingBook = applyPatch(chengdu, { ...meetingMove.request, id: "p_meeting" });
  if (!meetingBook.ok) return meetingBook.error;
  const meetingAt = meetingBook.book.items.find((item) => item.id === meeting.id);
  if (meetingAt?.startTime !== "15:00") return `开会应改到 15:00，得到 ${meetingAt?.startTime}`;

  const missed = validateExtract(
    {
      kind: "办事",
      origin: "上海",
      destination: { city: "济南", area: "汉峪金谷" },
      startDate: "2026-11-09",
      endDate: "2026-11-10",
      party: 1,
      outbound: { date: "2026-11-09", time: "14:00", mode: "高铁", from: "上海", to: "济南" },
      inbound: { date: "2026-11-10", time: "16:30", mode: null, from: "济南", to: "上海" },
      fixed: [],
      lodging: { booked: false, area: null },
      interests: [],
      pace: null,
      budget: null,
      missing: ["体检"],
    },
    now,
    JINAN_BRIEF,
  );
  if (!missed.ok) return "漏了体检的抽取仍应能校验";
  const filled = buildDraftFromSpec(specFromExtract(missed.value, now, missed.ask, JINAN_BRIEF), {
    id: "filled",
    now,
    random,
  });
  const filledCheck = filled.items.find((item) => item.title.includes("体检"));
  if (!filledCheck || filledCheck.locked || !`${filledCheck.note ?? ""}`.includes("时间推断")) {
    return "模型漏掉的体检应用规则补上，标时间推断且不锁定";
  }
  const filledOut = filled.items.find((item) => item.title === "从上海前往济南");
  const filledBack = filled.items.find((item) => item.dayIndex === 2 && item.type === "交通" && item.title.includes("上海"));
  if (!filledOut || !filledBack || filledBack.durationMinutes !== filledOut.durationMinutes || filledBack.durationMinutes <= 180) {
    return `返程没写方式时应沿用去程高铁且长于 180，得到 ${filledBack?.durationMinutes}`;
  }
  if (!filled.items.some((item) => item.dayIndex === 1 && item.title.includes("回酒店"))) return "说了订好酒店应出现回酒店";

  const vagueCity = validateExtract(
    {
      kind: "旅游",
      origin: null,
      destination: { city: "个暖和的地方", area: null },
      startDate: null,
      endDate: null,
      party: null,
      outbound: null,
      inbound: null,
      fixed: [],
      lodging: null,
      interests: [],
      pace: null,
      budget: null,
      missing: [],
    },
    now,
    "想去个暖和的地方",
  );
  if (vagueCity.ok || vagueCity.ask !== "去哪座城市？") return "含糊城市应只追问去哪座城市";

  const tired = planTired(jinan, tuesday, random);
  if (!tired.request) return tired.note || "累了没有计划";
  const tiredBook = applyPatch(jinan, { ...tired.request, id: "p_tired_station" });
  if (!tiredBook.ok) return tiredBook.error;
  if (tiredBook.book.items.find((item) => item.title === "去车站")?.startTime !== "15:30") return "累了不应挪动去车站";
  const rest = tiredBook.book.items.find((item) => item.dayIndex === 2 && item.title === "坐下休息");
  if (rest && (parseTime(rest.startTime) ?? 0) >= (parseTime("15:30") ?? 0)) return "休息不能排到去车站后面";
  const rain = planRain(jinan, tuesday);
  if (rain.request) {
    const rained = applyPatch(jinan, { ...rain.request, id: "p_rain_station" });
    if (!rained.ok) return rained.error;
    if (rained.book.items.find((item) => item.title === "去车站")?.startTime !== "15:30") return "下雨不应挪动去车站";
  }

  if (summarizeChanges(6, 14, "1 天", true) !== "已按 1 天重排：改了 6 项，拿掉 14 项") {
    return `重排摘要不对：${summarizeChanges(6, 14, "1 天", true)}`;
  }
  if (summarizeChanges(2, 1, "1 天", false) !== "改了 2 项，拿掉 1 项") return "5 项以内的摘要不应套用整份重排句式";
  return null;
}

function assertInferredReturn(book: Roadbook, origin: string, day: number): string | null {
  const back = book.items.find((item) => item.type === "交通" && item.title === `返回${origin}`);
  if (!back) return `应有返回${origin}`;
  if (back.dayIndex !== day || back.startTime !== "18:00" || back.locked) {
    return `返回${origin} 应在第 ${day} 天 18:00 且不锁定，得到第 ${back.dayIndex} 天 ${back.startTime} locked=${back.locked}`;
  }
  const blob = `${back.note ?? ""}${back.source.note ?? ""}`;
  if (!blob.includes("时间推断")) return `推断返程应标时间推断：${blob}`;
  if (blob.includes("来自你的原话")) return "推断返程不应标来自你的原话";
  if (!back.note?.includes("原话没提返程")) return `返程备注不对：${back.note}`;
  const tag = book.assumptions.find((item) => item.key === "return");
  if (!tag?.inferred || !tag.value.includes(`第 ${day} 天`)) return `返程假设应为第 ${day} 天傍晚：${tag?.value}`;
  const station = book.items.find((item) => item.dayIndex === day && item.title === "去车站");
  if (!station) return "推断返程前应有去车站";
  const depart = parseTime(back.startTime) ?? 0;
  const buffer = parseTime(station.startTime) ?? -1;
  if (depart - buffer !== 60) return `去车站应在返程前 60 分钟，得到 ${station.startTime}`;
  return null;
}

function assertRound3(): string | null {
  for (const sample of ["2000", "2,000", "两千", "¥2000", "预算大约是 ¥2000"]) {
    if (!budgetMentioned(sample, "2000")) return `应认出预算 2000：${sample}`;
  }
  if (budgetMentioned("没有写金额", "2000")) return "没有金额时不应算写了预算";
  if (!budgetMentioned("总预算八百，不含车票", "800")) return "应认出八百";

  const now = new Date("2026-11-09T02:00:00.000Z");
  let n = 0;
  const random = () => `r${(n += 1)}`;
  const arrivalBrief = "明天下午2点从上海坐高铁去苏州，5点到";
  const arrived = buildDraft(arrivalBrief, { id: "sz-arrive", now, random });
  if (arrived.city !== "苏州") return `苏州到达句应是苏州，得到 ${arrived.city}`;
  const outbound = arrived.items.find((item) => item.type === "交通" && item.title.includes("前往苏州"));
  if (!outbound || outbound.startTime !== "14:00") return `去程应 14:00 出发，得到 ${outbound?.startTime}`;
  const outboundEnd = (parseTime(outbound.startTime) ?? 0) + outbound.durationMinutes;
  if (outboundEnd !== 17 * 60) return `5点到应落在去程上，结束于 ${outboundEnd} 分钟处`;
  const lockedReturn = arrived.items.find(
    (item) => item.locked && item.type === "交通" && (item.title.startsWith("返回") || item.startTime === "17:00"),
  );
  if (lockedReturn) return `不应锁定返程：${lockedReturn.title} ${lockedReturn.startTime}`;
  const arrivedReturn = assertInferredReturn(arrived, "上海", 3);
  if (arrivedReturn) return `苏州 5 点到：${arrivedReturn}`;
  const arrivedBack = arrived.items.find((item) => item.title === "返回上海");
  if (!arrivedBack || arrivedBack.durationMinutes >= 90 || arrivedBack.durationMinutes === outbound.durationMinutes) {
    return `写了 5 点到时，返程应沿用沪苏估计而不是 ${outbound.durationMinutes} 分钟的到达跨度，得到 ${arrivedBack?.durationMinutes}`;
  }

  const echoed = bookFromExtract(
    {
      kind: "旅游",
      origin: "上海",
      destination: { city: "苏州", area: null },
      startDate: "2026-11-10",
      endDate: null,
      party: null,
      outbound: { date: "2026-11-10", time: "14:00", mode: "高铁", from: "上海", to: "苏州" },
      inbound: { date: "2026-11-10", time: "17:00", mode: "高铁", from: "苏州", to: "上海" },
      fixed: [],
      lodging: null,
      interests: [],
      pace: null,
      budget: null,
      missing: [],
    },
    arrivalBrief,
    now,
    "sz-echo",
  );
  if (typeof echoed === "string") return echoed;
  const echoedOut = echoed.items.find((item) => item.type === "交通" && item.title.includes("前往苏州"));
  const echoedEnd = echoedOut ? (parseTime(echoedOut.startTime) ?? 0) + echoedOut.durationMinutes : -1;
  if (!echoedOut || echoedOut.startTime !== "14:00" || echoedEnd !== 17 * 60) {
    return `模型把 5 点到抄进返程时，17:00 仍应在去程上，得到 ${echoedOut?.startTime} 结束 ${echoedEnd}`;
  }
  const echoedReturn = assertInferredReturn(echoed, "上海", 3);
  if (echoedReturn) return `模型抄了 17:00 返程：${echoedReturn}`;

  const wuzhenRules = buildDraft("周六从杭州去乌镇", { id: "wz-rules", now, random });
  const wuzhenModel = bookFromExtract(
    {
      kind: "旅游",
      origin: "杭州",
      destination: { city: "嘉兴", area: null },
      startDate: "2026-11-14",
      endDate: "2026-11-16",
      party: null,
      outbound: { date: "2026-11-14", time: null, mode: null, from: "杭州", to: "嘉兴" },
      inbound: { date: "2026-11-16", time: "15:00", mode: null, from: "嘉兴", to: "杭州" },
      fixed: [],
      lodging: null,
      interests: ["乌镇"],
      pace: null,
      budget: null,
      missing: [],
    },
    "周六从杭州去乌镇",
    now,
    "wz-model",
  );
  if (typeof wuzhenModel === "string") return wuzhenModel;
  const rulesReturn = assertInferredReturn(wuzhenRules, "杭州", 3);
  if (rulesReturn) return `乌镇规则：${rulesReturn}`;
  const modelReturn = assertInferredReturn(wuzhenModel, "杭州", 3);
  if (modelReturn) return `乌镇抽取：${modelReturn}`;
  const rulesBack = wuzhenRules.items.find((item) => item.title === "返回杭州");
  const modelBack = wuzhenModel.items.find((item) => item.title === "返回杭州");
  if (!rulesBack || !modelBack) return "两条路径都应有返回杭州";
  if (rulesBack.startTime !== modelBack.startTime || rulesBack.source.note !== modelBack.source.note) {
    return `乌镇返程没有对齐：规则 ${rulesBack.startTime}/${rulesBack.source.note}，抽取 ${modelBack.startTime}/${modelBack.source.note}`;
  }
  const rulesOut = wuzhenRules.items.find((item) => item.type === "交通" && item.title.includes("前往嘉兴"));
  const modelOut = wuzhenModel.items.find((item) => item.type === "交通" && item.title.includes("前往嘉兴"));
  if (!rulesOut || rulesOut.durationMinutes !== rulesBack.durationMinutes || rulesOut.durationMinutes >= 90) {
    return `乌镇去程和返程应共用杭州到嘉兴的估计，而不是 90 对 120，得到 ${rulesOut?.durationMinutes} / ${rulesBack.durationMinutes}`;
  }
  if (!modelOut || modelOut.durationMinutes !== modelBack.durationMinutes || modelOut.durationMinutes !== rulesOut.durationMinutes) {
    return `乌镇抽取应与规则共用同一时长，得到规则 ${rulesOut.durationMinutes} 抽取 ${modelOut?.durationMinutes}/${modelBack.durationMinutes}`;
  }

  for (const brief of ["周六从杭州去乌镇，单程", "周六从杭州去乌镇，然后去上海"]) {
    const book = buildDraft(brief, { id: "wz-oneway", now, random });
    if (book.items.some((item) => item.title.startsWith("返回") || item.title.includes("前往杭州"))) {
      return `${brief} 不应推断返程`;
    }
    if (book.assumptions.some((item) => item.key === "return")) return `${brief} 不应有返程假设`;
  }

  const hop = buildDraft("明天下午2点从上海坐高铁去苏州", { id: "sz-hop", now, random });
  const hopRide = hop.items.find((item) => item.type === "交通" && item.title.includes("前往苏州"));
  const hopBack = hop.items.find((item) => item.title === "返回上海");
  if (!hopRide || hopRide.durationMinutes >= 90) return `沪苏高铁应远小于 180 分钟，得到 ${hopRide?.durationMinutes}`;
  if (!hopBack || hopBack.durationMinutes !== hopRide.durationMinutes) {
    return `沪苏去程和返程应一样短，得到 ${hopRide.durationMinutes} / ${hopBack?.durationMinutes}`;
  }
  if (arrivedBack.durationMinutes !== hopRide.durationMinutes) {
    return `5点到的返程应等于没写到达时的沪苏估计 ${hopRide.durationMinutes}，得到 ${arrivedBack.durationMinutes}`;
  }

  const lake = buildDraft("这周末去西湖，周六下午3点到8点在湖边走走", { id: "lake-range", now, random });
  if (lake.city !== "杭州") return `西湖应是杭州，得到 ${lake.city}`;
  const shore = lake.items.find((item) => item.type === "景点" && item.title.includes("西湖"));
  if (!shore || shore.startTime !== "15:00" || shore.durationMinutes !== 300) {
    return `西湖应 15:00 起到 20:00，得到 ${shore?.title} ${shore?.startTime} ${shore?.durationMinutes} 分钟`;
  }
  if (lake.items.some((item) => item.title.includes("湖边"))) return "湖边不应单独排成景点";
  const shoreAsk = buildDraft("想去湖边走走", { id: "shore-ask", now, random });
  if (shoreAsk.question?.prompt !== "去哪座城市？" || shoreAsk.items.length > 0 || shoreAsk.city === "杭州") {
    return `想去湖边走走应只追问去哪座城市，得到 ${shoreAsk.city} ${shoreAsk.question?.prompt ?? "无"} 项${shoreAsk.items.length}`;
  }

  const dawnBrief = "周六早上6点从济南出发去泰山";
  const dawnSpec = specFromRules(dawnBrief, now);
  if (dawnSpec.outbound?.time !== "06:00") return `规则去程应是 06:00，得到 ${dawnSpec.outbound?.time}`;
  const dawn = buildDraft(dawnBrief, { id: "tai-dawn", now, random });
  const dawnRide = dawn.items.find((item) => item.type === "交通" && item.title.includes("济南") && (item.title.includes("泰安") || item.title.includes("泰山")));
  if (!dawnRide || dawnRide.startTime !== "06:00") return `早上 6 点出发应是 06:00，得到 ${dawnRide?.startTime} ${dawnRide?.title}`;

  const tai = buildDraft("明天早上7点去爬泰山", { id: "tai-move", now, random });
  const climb = tai.items.find((item) => item.type === "景点" && item.title.includes("泰山"));
  if (!climb?.locked || climb.startTime !== "07:00") return `前置：泰山应锁在 07:00，得到 ${climb?.startTime}`;
  const moved = planMessage(tai, "把泰山改到8点", random, now);
  if (!moved.request) return moved.note || "把泰山改到8点没有生效";
  const movedBook = applyPatch(tai, { ...moved.request, id: "p_tai_8" });
  if (!movedBook.ok) return movedBook.error;
  const atEight = movedBook.book.items.find((item) => item.id === climb.id);
  if (atEight?.startTime !== "08:00" || !atEight.locked) {
    return `泰山应锁在 08:00，得到 ${atEight?.startTime} locked=${atEight?.locked}`;
  }
  const rain = planRain(movedBook.book, now);
  if (rain.request) {
    const rained = applyPatch(movedBook.book, { ...rain.request, id: "p_tai_rain" });
    if (!rained.ok) return rained.error;
    const still = rained.book.items.find((item) => item.id === climb.id);
    if (still?.startTime !== "08:00" || !still.locked) return "下雨不应挪动锁定的泰山";
  }

  const wuzhen = buildDraft("周六从杭州去乌镇", { id: "wz-edit", now, random });
  const shorten = planMessage(wuzhen, "改成2天", random, now);
  if (!shorten.request) return shorten.note || "改成2天没有生效";
  if (shorten.note.includes("返程已锁定")) return "未锁定的返程不应挡住改天数";
  const shortBook = applyPatch(wuzhen, { ...shorten.request, id: "p_wz_2" });
  if (!shortBook.ok) return shortBook.error;
  const backOnTwo = shortBook.book.items.find((item) => item.title === "返回杭州");
  if (backOnTwo?.dayIndex !== 2 || backOnTwo.locked) return `改成 2 天应把未锁定返程挪到第 2 天，得到第 ${backOnTwo?.dayIndex} 天`;
  const tag = shortBook.book.assumptions.find((item) => item.key === "return");
  if (!tag?.value.includes("第 2 天")) return `返程假设应跟着变成第 2 天：${tag?.value}`;

  const lateNow = new Date("2026-11-16T02:00:00.000Z");
  const station = wuzhen.items.find((item) => item.title === "去车站");
  if (!station) return "短途返程前应有去车站";
  const late = planLate(wuzhen, lateNow);
  if (!late.request) return late.note || "晚了 1 小时没有计划";
  const lateBook = applyPatch(wuzhen, { ...late.request, id: "p_wz_late" });
  if (!lateBook.ok) return lateBook.error;
  if (lateBook.book.items.find((item) => item.id === station.id)?.startTime !== station.startTime) return "晚了不应挪去车站";
  const cutoff = parseTime(station.startTime) ?? 0;
  const spilled = lateBook.book.items.filter((item) => {
    if (item.dayIndex !== station.dayIndex || item.locked || item.title === "去车站" || item.title.startsWith("返回")) return false;
    const start = parseTime(item.startTime);
    return start != null && start >= cutoff;
  });
  if (spilled.length > 0) return `去车站之后不该再排：${spilled.map((item) => item.title).join("、")}`;

  const partyBook = bookFromExtract(
    {
      kind: "旅游",
      origin: null,
      destination: { city: "杭州", area: null },
      startDate: "2026-11-14",
      endDate: "2026-11-15",
      party: null,
      outbound: null,
      inbound: null,
      fixed: [],
      lodging: null,
      interests: ["西湖"],
      pace: null,
      budget: null,
      missing: [],
    },
    "这周末想去西湖走走，两个人",
    now,
    "party-fill",
  );
  if (typeof partyBook === "string") return partyBook;
  if (partyBook.assumptions.find((item) => item.key === "party")?.value !== "两个人") {
    return "原话写了两个人，抽取漏了也要补上";
  }

  const errand = buildDraft("明天从上海去济南体检", { id: "errand-back", now, random });
  if (errand.city !== "济南" || errand.items.some((item) => item.type === "景点")) return "办事短途不应塞景点";
  const errandReturn = assertInferredReturn(errand, "上海", 3);
  if (errandReturn) return `办事短途：${errandReturn}`;
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
    { brief: JINAN_BRIEF, check: (book) => assertJinanBook(book, shanghaiDate(now)) },
    {
      brief: "想去爬泰山",
      check: (book) => assertTaishanShape(book),
    },
    {
      brief: "周六从杭州去乌镇",
      check: (book) => {
        if (book.city !== "嘉兴") return `乌镇应是嘉兴，得到 ${book.city}`;
        const named = assertNamedSight(book, "乌镇");
        if (named) return named;
        const back = assertReturnTo(book, "杭州");
        if (back) return back;
        return overlappingMeal(book, "乌镇");
      },
    },
    {
      brief: "明天从北京坐飞机到西宁，玩3天",
      check: (book) => {
        if (book.city !== "西宁" || book.items.length === 0) return `西宁应排出行程，得到 ${book.city}`;
        if (!book.items.some((item) => item.dayIndex === 3 && item.type === "景点")) return "西宁第 3 天没有景点";
        const flight = book.items.find((item) => item.title.includes("北京") && item.title.includes("西宁"));
        if (!flight) return "西宁去程缺失";
        return null;
      },
    },
    {
      brief: "坐飞机到西宁",
      check: (book) => {
        if (book.question || book.items.length === 0 || book.city !== "西宁") return `坐飞机到西宁应排出西宁，得到 ${book.city}`;
        return null;
      },
    },
    {
      brief: "想去个暖和的地方",
      check: (book) => {
        if (book.question?.prompt !== "去哪座城市？" || book.items.length > 0) return "想去个暖和的地方应只追问，行程项为空";
        return null;
      },
    },
    {
      brief: "明天早上7点去爬泰山",
      check: (book) => assertStatedTaishan(book),
    },
    {
      brief: "周六去乌镇，下午3点到",
      check: (book) => assertWuzhenArrival(book),
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
        const legs = book.items.filter(
          (item) => item.type === "交通" && (item.title.startsWith("从") || item.title.startsWith("返回")),
        );
        const outbound = legs.find((item) => item.title.includes("前往苏州"));
        if (book.city !== "苏州" || span !== 1 || !outbound?.locked || legs.length < 2) {
          return `苏州当天回应有锁定去程和返程，得到 ${book.city} ${span} 交通${legs.length}`;
        }
        return blobHasSelfTrip(book) ? "出现了从上海前往上海" : null;
      },
    },
    {
      brief: "从上海出发，就在上海周边玩",
      check: (book) => {
        if (blobHasSelfTrip(book)) return "出现了从上海前往上海";
        if (book.items.length > 0 || book.question?.prompt !== "去哪座城市？") return "上海周边应只追问，行程项为空";
        return null;
      },
    },
    {
      brief: "明天下午2点从上海坐高铁去苏州，5点到",
      check: (book) => {
        const ride = book.items.find((item) => item.type === "交通" && item.title.includes("前往苏州"));
        if (!ride || ride.startTime !== "14:00") return `去程应 14:00 出发，得到 ${ride?.startTime}`;
        const end = (parseTime(ride.startTime) ?? 0) + ride.durationMinutes;
        if (end !== 17 * 60) return "5点到应落在去程上";
        const span = book.items.reduce((max, item) => Math.max(max, item.dayIndex), 1);
        if (span !== 3) return `没写天数应是 3 天，得到 ${span}`;
        return assertInferredReturn(book, "上海", 3);
      },
    },
    {
      brief: "周六从杭州去乌镇，单程",
      check: (book) => (book.items.some((item) => item.title.startsWith("返回")) ? "单程不应推断返程" : null),
    },
    {
      brief: "这周末去西湖，周六下午3点到8点在湖边走走",
      check: (book) => {
        if (book.city !== "杭州") return `西湖应是杭州，得到 ${book.city}`;
        const shore = book.items.find((item) => item.type === "景点" && item.title.includes("西湖"));
        if (!shore || shore.startTime !== "15:00" || shore.durationMinutes !== 300) {
          return `西湖应 15:00 起到 20:00，得到 ${shore?.title} ${shore?.startTime} ${shore?.durationMinutes}`;
        }
        return null;
      },
    },
    {
      brief: "周六早上6点从济南出发去泰山",
      check: (book) => {
        const ride = book.items.find((item) => item.type === "交通" && item.title.includes("济南"));
        if (!ride || ride.startTime !== "06:00") return `早上 6 点出发应是 06:00，得到 ${ride?.startTime}`;
        return null;
      },
    },
  ];
  const problems = await mapFixtures(cases, LIVE_CONCURRENCY, async (item) => {
    const extract = await extractBrief(item.brief, now, env);
    if (!extract) return `在线抽取没有返回结构：${item.brief.slice(0, 24)}`;
    const validated = validateExtract(extract, now, item.brief);
    const book = validated.ok
      ? buildDraftFromSpec(specFromExtract(validated.value, now, validated.ask, item.brief), { id: "live", now, random: sequence() })
      : validated.ask
        ? buildDraftFromSpec(specForQuestion(item.brief, validated.ask), { id: "live-ask", now, random: sequence() })
        : buildDraft(item.brief, { id: "live-rules", now, random: sequence() });
    if (blobHasSelfTrip(book)) return `${item.brief.slice(0, 18)} 出现了从上海前往上海`;
    const problem = item.check(book);
    return problem ? `${item.brief.slice(0, 24)}：${problem}` : null;
  });
  const failed = problems.filter((item): item is string => Boolean(item));
  return failed.length > 0 ? failed.join("\n") : null;
}

function daySpan(book: Roadbook): number {
  return book.items.reduce((max, item) => Math.max(max, item.dayIndex), 1);
}

function looseExtract(
  city: string,
  origin: string | null,
  start: string | null,
  end: string | null,
  extra: Partial<TripExtract> = {},
): TripExtract {
  const { destination, ...rest } = extra;
  return {
    kind: "旅游",
    origin,
    startDate: start,
    endDate: end,
    party: null,
    outbound: null,
    inbound: null,
    fixed: [],
    lodging: null,
    interests: [],
    pace: null,
    budget: null,
    missing: [],
    ...rest,
    destination: destination ?? { city, area: null },
  };
}

function assertNoReturn(book: Roadbook): string | null {
  if (book.items.some((item) => item.type === "交通" && item.title.startsWith("返回"))) return `不应推断返程：${book.title}`;
  if (book.assumptions.some((item) => item.key === "return")) return "不应有返程假设";
  return null;
}

function assertSpanBriefs(): string | null {
  const now = new Date("2026-11-09T02:00:00.000Z");
  let n = 0;
  const random = () => `s${(n += 1)}`;
  const arrivalBrief = "明天下午2点从上海坐高铁去苏州，5点到";
  const guessed = bookFromExtract(
    looseExtract("苏州", "上海", "2026-11-10", "2026-11-10", {
      outbound: { date: "2026-11-10", time: "14:00", mode: "高铁", from: "上海", to: "苏州" },
      inbound: { date: "2026-11-10", time: "17:00", mode: "高铁", from: "苏州", to: "上海" },
    }),
    arrivalBrief,
    now,
    "sz-guessed-same-day",
  );
  if (typeof guessed === "string") return guessed;
  if (daySpan(guessed) !== 3) return `没写天数的同一天 endDate 应回落到 3 天，得到 ${daySpan(guessed)}`;
  const guessedOut = guessed.items.find((item) => item.type === "交通" && item.title.includes("前往苏州"));
  const guessedEnd = guessedOut ? (parseTime(guessedOut.startTime) ?? 0) + guessedOut.durationMinutes : -1;
  if (!guessedOut?.locked || guessedOut.startTime !== "14:00" || guessedEnd !== 17 * 60) {
    return `去程应锁定 14:00 并在 17:00 到，得到 ${guessedOut?.startTime} locked=${guessedOut?.locked} 结束 ${guessedEnd}`;
  }
  const guessedReturn = assertInferredReturn(guessed, "上海", 3);
  if (guessedReturn) return `猜的同一天结束：${guessedReturn}`;

  const bareDay = bookFromExtract(
    looseExtract("苏州", "上海", "2026-11-10", "2026-11-10", {
      outbound: { date: "2026-11-10", time: "14:00", mode: "高铁", from: "上海", to: "苏州" },
    }),
    "明天从上海坐高铁去苏州，当天",
    now,
    "sz-bare-today",
  );
  if (typeof bareDay === "string") return bareDay;
  if (daySpan(bareDay) !== 3) return `单独的「当天」不应留成 1 天，得到 ${daySpan(bareDay)}`;

  const oneDayBriefs = [
    "明天从上海坐高铁去苏州，当天回",
    "明天从上海坐高铁去苏州，当日往返",
    "明天从上海坐高铁去苏州，当日回",
    "明天从上海去苏州，只玩一天",
    "明天从上海去苏州一日游",
  ];
  for (const brief of oneDayBriefs) {
    const rules = buildDraft(brief, { id: "one-day-rules", now, random });
    if (daySpan(rules) !== 1) return `规则 ${brief} 应是 1 天，得到 ${daySpan(rules)}`;
    const model = bookFromExtract(
      looseExtract("苏州", "上海", "2026-11-10", "2026-11-10", {
        outbound: { date: "2026-11-10", time: "09:00", mode: "高铁", from: "上海", to: "苏州" },
        inbound: { date: "2026-11-10", time: null, mode: "高铁", from: "苏州", to: "上海" },
      }),
      brief,
      now,
      "one-day-model",
    );
    if (typeof model === "string") return `${brief} ${model}`;
    if (daySpan(model) !== 1) return `抽取 ${brief} 应是 1 天，得到 ${daySpan(model)}`;
    const phrase = brief.match(/当天回|当日往返|当日回/)?.[0];
    for (const book of [rules, model]) {
      const back = book.items.find((item) => item.title === "返回上海" || item.title.startsWith("返回"));
      const tag = book.assumptions.find((item) => item.key === "return");
      if (!back) return `${brief} 应有返回上海，得到 ${book.items.filter((item) => item.type === "交通").map((item) => item.title).join("、")}`;
      if (phrase) {
        if (back.locked || back.startTime !== "18:00") {
          return `${brief} 没写钟点的返程应是未锁定的 18:00，得到 ${back.startTime} locked=${back.locked}`;
        }
        const blob = `${back.note ?? ""}${back.source.note ?? ""}`;
        if (!blob.includes("时间推断") || blob.includes("来自你的原话")) return `${brief} 返程应标时间推断：${blob}`;
        if (back.note?.includes("原话没提返程") || (!back.note?.includes(phrase) && !back.note?.includes("钟点没写"))) {
          return `${brief} 返程备注应沿用原话：${back.note}`;
        }
        if (tag?.value !== "钟点没写，按当天傍晚估" || tag.value.includes("没写，按第")) {
          return `${brief} 返程标签应为钟点没写，得到 ${tag?.value}`;
        }
      } else if (!back.note?.includes("原话没提返程") || tag?.value !== "没写，按第 1 天 18:00 估") {
        return `${brief} 没提返程应保留原备注和标签：${back.note} / ${tag?.value}`;
      }
    }
  }

  const voicedClock = buildDraft("明天早上8点从上海坐高铁去苏州，下午6点当天回", { id: "voiced-clock", now, random });
  const voicedBack = voicedClock.items.find((item) => item.title.includes("上海") && item.title !== "从上海前往苏州" && item.type === "交通");
  const voicedBlob = `${voicedBack?.note ?? ""}${voicedBack?.source.note ?? ""}`;
  if (!voicedBack?.locked || voicedBack.startTime !== "18:00" || !voicedBlob.includes("来自你的原话")) {
    return `写了返程钟点应锁定并标来自你的原话，得到 ${voicedBack?.title} ${voicedBack?.startTime} locked=${voicedBack?.locked} ${voicedBlob}`;
  }
  if (voicedClock.assumptions.some((item) => item.key === "return" && item.value.includes("钟点没写"))) {
    return "写了返程钟点不应再标钟点没写";
  }

  const fiveDayBriefs = ["从上海去北京玩5天", "从上海去北京五天", "从上海去北京五天四晚"];
  for (const brief of fiveDayBriefs) {
    const rules = buildDraft(brief, { id: "five-rules", now, random });
    if (daySpan(rules) !== 5) return `规则 ${brief} 应是 5 天，得到 ${daySpan(rules)}`;
    const rulesReturn = assertNoReturn(rules);
    if (rulesReturn) return `规则 ${brief}：${rulesReturn}`;
    const model = bookFromExtract(looseExtract("北京", "上海", "2026-11-10", null), brief, now, "five-model");
    if (typeof model === "string") return `${brief} ${model}`;
    if (daySpan(model) !== 5) return `抽取没写 endDate 的 ${brief} 应是 5 天，得到 ${daySpan(model)}`;
    const modelReturn = assertNoReturn(model);
    if (modelReturn) return `抽取 ${brief}：${modelReturn}`;
    const guessedFive = bookFromExtract(
      looseExtract("北京", "上海", "2026-11-10", "2026-11-10"),
      brief,
      now,
      "five-guessed",
    );
    if (typeof guessedFive === "string") return `${brief} ${guessedFive}`;
    if (daySpan(guessedFive) !== 5) return `抽取把 ${brief} 猜成当天时应仍是 5 天，得到 ${daySpan(guessedFive)}`;
  }

  const openBrief = "从上海去北京";
  const openRules = buildDraft(openBrief, { id: "open-rules", now, random });
  if (daySpan(openRules) !== 3) return `没写天数应默认 3 天，得到 ${daySpan(openRules)}`;
  const openReturn = assertInferredReturn(openRules, "上海", 3);
  if (openReturn) return `短途默认：${openReturn}`;
  const openModel = bookFromExtract(looseExtract("北京", "上海", null, null), openBrief, now, "open-model");
  if (typeof openModel === "string") return openModel;
  if (daySpan(openModel) !== 3) return `抽取没写日期和天数应默认 3 天，得到 ${daySpan(openModel)}`;
  const openModelReturn = assertInferredReturn(openModel, "上海", 3);
  if (openModelReturn) return `抽取短途默认：${openModelReturn}`;

  const shoreModel = validateExtract(looseExtract("杭州", null, null, null, { interests: ["西湖"] }), now, "想去湖边走走");
  if (shoreModel.ok || shoreModel.ask !== "去哪座城市？") return "抽取把湖边当成杭州时应追问去哪座城市";
  const shoreVague = validateExtract(looseExtract("湖边", null, null, null), now, "想去湖边走走");
  if (shoreVague.ok || shoreVague.ask !== "去哪座城市？") return "抽取目的地写成湖边时应追问去哪座城市";
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

const BEIJING_SIGHTS = ["故宫", "中国国家博物馆", "景山", "颐和园", "天坛"];
const SIGHT_FILLERS = ["城区再走一段", "公园里坐一会儿", "附近随便走走", "再走走"];

function firstOutbound(book: Roadbook): RoadbookItem | undefined {
  return book.items.find((item) => item.dayIndex === 1 && item.type === "交通" && item.title.includes("前往"));
}

function returnRide(book: Roadbook, origin: string): RoadbookItem | undefined {
  return book.items.find((item) => item.type === "交通" && item.title === `返回${origin}`);
}

function assertSharedRide(rules: Roadbook, other: Roadbook, origin: string, label: string): string | null {
  const rulesOut = firstOutbound(rules);
  const rulesBack = returnRide(rules, origin);
  const otherOut = firstOutbound(other);
  const otherBack = returnRide(other, origin);
  if (!rulesOut || !rulesBack || !otherOut || !otherBack) {
    return `${label} 应有去程和返回${origin}，规则 ${rulesOut?.title ?? "无"}/${rulesBack?.title ?? "无"}，另一条 ${otherOut?.title ?? "无"}/${otherBack?.title ?? "无"}`;
  }
  const durations = [rulesOut.durationMinutes, rulesBack.durationMinutes, otherOut.durationMinutes, otherBack.durationMinutes];
  if (new Set(durations).size !== 1) {
    return `${label} 去程和返程应共用同一估计，得到规则 ${rulesOut.durationMinutes}/${rulesBack.durationMinutes}，另一条 ${otherOut.durationMinutes}/${otherBack.durationMinutes}`;
  }
  return null;
}

function assertAfterArrival(book: Roadbook, label: string): string | null {
  const ride = firstOutbound(book);
  if (!ride || ride.durationMinutes < 300 || ride.durationMinutes > 360) {
    return `${label} 去程应约 320 分钟，得到 ${ride?.title ?? "无"} ${ride?.durationMinutes ?? "无"}`;
  }
  const end = (parseTime(ride.startTime) ?? 0) + ride.durationMinutes;
  const floor = Math.ceil(end / 10) * 10;
  for (const item of book.items) {
    if (item.dayIndex !== 1 || item.type === "交通") continue;
    const start = parseTime(item.startTime);
    if (start == null || start < floor) {
      return `${label} ${item.title} ${item.startTime} 早于到达后的 ${floor} 分钟`;
    }
  }
  if (book.items.some((item) => item.dayIndex === 1 && item.type === "餐" && item.startTime === "10:00")) {
    return `${label} 不应把早餐放在 10:00`;
  }
  if (book.items.some((item) => item.dayIndex === 1 && item.title.includes("故宫") && item.startTime === "11:00")) {
    return `${label} 不应把故宫放在 11:00`;
  }
  return null;
}

function assertNoNumberedFiller(book: Roadbook, label: string): string | null {
  const numbered = book.items.filter((item) => /^再走走\d+$/.test(item.title));
  if (numbered.length > 0) return `${label} 出现了编号占位：${numbered.map((item) => item.title).join("、")}`;
  return null;
}

function assertDayFiveSight(book: Roadbook, label: string): string | null {
  const sights = book.items.filter((item) => item.dayIndex === 5 && item.type === "景点");
  const free = book.items.some((item) => item.dayIndex === 5 && item.title === "自由活动");
  if (sights.length === 0 && !free) return `${label} 第 5 天应有景点或自由活动`;
  const bad = sights.filter(
    (item) => !BEIJING_SIGHTS.some((name) => item.title.includes(name)) && !SIGHT_FILLERS.includes(item.title) && item.title !== "自由活动",
  );
  if (bad.length > 0) return `${label} 第 5 天景点不对：${bad.map((item) => item.title).join("、")}`;
  return null;
}

function assertNoRepeatedSights(book: Roadbook, label: string): string | null {
  const seen = new Map<string, number>();
  for (const item of book.items) {
    if (item.type !== "景点") continue;
    seen.set(item.title, (seen.get(item.title) ?? 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, count]) => count > 1);
  if (dupes.length > 0) return `${label} 重复了景点：${dupes.map(([title, count]) => `${title}×${count}`).join("、")}`;
  const numbered = assertNoNumberedFiller(book, label);
  if (numbered) return numbered;
  return null;
}

function assertHopBeforeBreakfast(book: Roadbook, label: string): string | null {
  const ride = firstOutbound(book);
  const breakfast = book.items.find((item) => item.dayIndex === 1 && item.type === "餐");
  if (!ride || !breakfast) return `${label} 应有去程和早餐`;
  const end = (parseTime(ride.startTime) ?? 0) + ride.durationMinutes;
  const start = parseTime(breakfast.startTime) ?? 0;
  if (ride.durationMinutes >= 90) return `${label} 沪苏应远小于 90 分钟，得到 ${ride.durationMinutes}`;
  if (end > start) return `${label} 去程 ${ride.startTime}+${ride.durationMinutes} 应在早餐 ${breakfast.startTime} 之前结束`;
  return null;
}

function assertConfirmedFixes(): string | null {
  const now = new Date("2026-11-09T02:00:00.000Z");
  let n = 0;
  const random = () => `f${(n += 1)}`;

  const wuzhenBrief = "周六从杭州去乌镇";
  const wuzhenRules = buildDraft(wuzhenBrief, { id: "fix-wz-rules", now, random });
  const wuzhenDirty = bookFromExtract(
    {
      kind: "旅游",
      origin: "杭州",
      destination: { city: "嘉兴", area: null },
      startDate: "2026-11-14",
      endDate: "2026-11-16",
      party: null,
      outbound: { date: "2026-11-14", time: null, mode: "其他", from: "杭州", to: "乌镇" },
      inbound: null,
      fixed: [],
      lodging: null,
      interests: ["乌镇"],
      pace: null,
      budget: null,
      missing: [],
    },
    wuzhenBrief,
    now,
    "fix-wz-dirty",
  );
  if (typeof wuzhenDirty === "string") return wuzhenDirty;
  const wuzhenRide = assertSharedRide(wuzhenRules, wuzhenDirty, "杭州", "乌镇脏去程");
  if (wuzhenRide) return wuzhenRide;
  const wuzhenOut = firstOutbound(wuzhenRules);
  if (!wuzhenOut || wuzhenOut.durationMinutes >= 90) {
    return `乌镇应沿用杭州到嘉兴的短途估计，得到 ${wuzhenOut?.durationMinutes}`;
  }

  const suBrief = "明天从上海去苏州，当天回";
  const suRules = buildDraft(suBrief, { id: "fix-su-rules", now, random });
  const suDirty = bookFromExtract(
    looseExtract("苏州", "上海", "2026-11-10", "2026-11-10", {
      outbound: { date: "2026-11-10", time: null, mode: null, from: null, to: null },
      inbound: { date: "2026-11-10", time: null, mode: null, from: null, to: null },
    }),
    suBrief,
    now,
    "fix-su-null",
  );
  if (typeof suDirty === "string") return suDirty;
  const suRide = assertSharedRide(suRules, suDirty, "上海", "沪苏空路段");
  if (suRide) return suRide;
  if ((firstOutbound(suRules)?.durationMinutes ?? 0) >= 90) return "沪苏空路段不应退回 120 分钟";

  const cdBrief = "下周三到周五从北京去成都出差，周四下午2点开会";
  const cdRules = buildDraft(cdBrief, { id: "fix-cd-rules", now, random });
  const cdOut = cdRules.items.find(
    (item) => item.dayIndex === 1 && item.type === "交通" && item.title.includes("北京") && item.title.includes("成都"),
  );
  const cdBack = cdRules.items.find((item) => item.dayIndex === 3 && item.type === "交通" && item.title === "返回北京");
  if (!cdOut || cdOut.startTime !== "08:00" || cdOut.locked) {
    return `成都出差应有未锁定的第 1 天 08:00 去程，得到 ${cdOut?.title ?? "无"} ${cdOut?.startTime} locked=${cdOut?.locked}`;
  }
  if (
    !cdBack ||
    cdOut.travelEstimateMinutes == null ||
    cdOut.travelEstimateMinutes !== cdBack.travelEstimateMinutes ||
    cdOut.travelEstimateMinutes <= 180
  ) {
    return `京蓉估计应两边同长且长于 180，得到 ${cdOut.travelEstimateMinutes}/${cdBack?.travelEstimateMinutes}`;
  }
  if (cdOut.durationMinutes !== cdOut.travelEstimateMinutes) {
    return `08:00 的京蓉去程应放下整段估计，得到 ${cdOut.durationMinutes} / 估计 ${cdOut.travelEstimateMinutes}`;
  }
  if (cdBack.startTime !== "16:00" || cdBack.durationMinutes !== 445 || cdBack.travelEstimateMinutes !== 445) {
    return `推断返程应在 16:00 且日历和估计都是 445，得到 ${cdBack.startTime} ${cdBack.durationMinutes}/${cdBack.travelEstimateMinutes}`;
  }
  const cdEnd = (parseTime(cdBack.startTime) ?? 0) + cdBack.durationMinutes;
  if (cdEnd > 23 * 60 + 30) return `16:00 的京蓉返程应在 23:30 前结束，得到 ${cdEnd}`;
  const cdTag = cdRules.assumptions.find((item) => item.key === "return");
  if (!cdTag?.value.includes("16:00") || cdTag.value.includes("傍晚")) {
    return `返程假设应写 16:00 而不是傍晚：${cdTag?.value}`;
  }
  const cdStation = cdRules.items.find((item) => item.dayIndex === 3 && item.title === "去车站");
  if (cdStation?.startTime !== "15:00") return `去车站应跟着到 15:00，得到 ${cdStation?.startTime}`;
  const meeting = cdRules.items.find((item) => item.title.includes("开会"));
  if (!meeting || meeting.dayIndex !== 2 || meeting.startTime !== "14:00") {
    return `开会应仍在第 2 天 14:00，得到第 ${meeting?.dayIndex} 天 ${meeting?.startTime}`;
  }
  const cdDirty = bookFromExtract(
    {
      kind: "办事",
      origin: "北京",
      destination: { city: "成都", area: null },
      startDate: "2026-11-18",
      endDate: "2026-11-20",
      party: null,
      outbound: { date: "2026-11-18", time: null, mode: null, from: null, to: null },
      inbound: { date: "2026-11-20", time: null, mode: null, from: null, to: null },
      fixed: [{ date: "2026-11-19", time: "14:00", endTime: null, title: "开会", place: "成都", type: "办事" }],
      lodging: null,
      interests: [],
      pace: null,
      budget: null,
      missing: [],
    },
    cdBrief,
    now,
    "fix-cd-null",
  );
  if (typeof cdDirty === "string") return cdDirty;
  const cdDirtyOut = firstOutbound(cdDirty);
  const cdDirtyBack = returnRide(cdDirty, "北京");
  if (
    !cdDirtyOut ||
    !cdDirtyBack ||
    cdDirtyOut.travelEstimateMinutes !== cdOut.travelEstimateMinutes ||
    cdDirtyBack.travelEstimateMinutes !== cdBack.travelEstimateMinutes ||
    cdDirtyOut.durationMinutes !== cdOut.durationMinutes ||
    cdDirtyBack.durationMinutes !== cdBack.durationMinutes ||
    cdDirtyBack.startTime !== "16:00"
  ) {
    return `成都空路段应与规则共用 16:00 / 445，得到 ${cdDirtyBack?.startTime} ${cdDirtyOut?.travelEstimateMinutes}/${cdDirtyBack?.travelEstimateMinutes} 日历 ${cdDirtyBack?.durationMinutes}`;
  }
  const cdDirtyTag = cdDirty.assumptions.find((item) => item.key === "return");
  if (!cdDirtyTag?.value.includes("16:00") || cdDirtyTag.value.includes("傍晚")) {
    return `抽取返程假设应写 16:00：${cdDirtyTag?.value}`;
  }

  for (const brief of ["从上海去北京玩5天", "从上海去北京玩2天"]) {
    const rules = buildDraft(brief, { id: "fix-bj-rules", now, random });
    const model = bookFromExtract(looseExtract("北京", "上海", "2026-11-10", null), brief, now, "fix-bj-model");
    if (typeof model === "string") return `${brief} ${model}`;
    const rulesArrival = assertAfterArrival(rules, `规则 ${brief}`);
    if (rulesArrival) return rulesArrival;
    const modelArrival = assertAfterArrival(model, `抽取 ${brief}`);
    if (modelArrival) return modelArrival;
    const rulesNumbered = assertNoNumberedFiller(rules, `规则 ${brief}`);
    if (rulesNumbered) return rulesNumbered;
    const modelNumbered = assertNoNumberedFiller(model, `抽取 ${brief}`);
    if (modelNumbered) return modelNumbered;
  }

  const fiveRules = buildDraft("从上海去北京玩5天", { id: "fix-bj5-rules", now, random });
  const fiveModel = bookFromExtract(looseExtract("北京", "上海", "2026-11-10", null), "从上海去北京玩5天", now, "fix-bj5-model");
  if (typeof fiveModel === "string") return fiveModel;
  const fiveRulesSight = assertDayFiveSight(fiveRules, "规则 北京5天");
  if (fiveRulesSight) return fiveRulesSight;
  const fiveModelSight = assertDayFiveSight(fiveModel, "抽取 北京5天");
  if (fiveModelSight) return fiveModelSight;
  if (fiveRules.items.some((item) => item.title.startsWith("返回")) || fiveModel.items.some((item) => item.title.startsWith("返回"))) {
    return "北京 5 天不应推断返程";
  }

  const hopBrief = "从上海去苏州玩2天";
  const hopRules = buildDraft(hopBrief, { id: "fix-hop-rules", now, random });
  const hopModel = bookFromExtract(looseExtract("苏州", "上海", "2026-11-10", null), hopBrief, now, "fix-hop-model");
  if (typeof hopModel === "string") return hopModel;
  const hopRulesMeal = assertHopBeforeBreakfast(hopRules, "规则 沪苏");
  if (hopRulesMeal) return hopRulesMeal;
  const hopModelMeal = assertHopBeforeBreakfast(hopModel, "抽取 沪苏");
  if (hopModelMeal) return hopModelMeal;

  const repeatedBriefs: { brief: string; city: string; extractCity: string }[] = [
    { brief: "从上海去北京玩5天", city: "北京", extractCity: "北京" },
    { brief: "从上海去西安玩7天", city: "西安", extractCity: "西安" },
    { brief: "从上海去东京玩5天", city: "东京", extractCity: "东京" },
    { brief: "从北京去哈尔滨玩4天", city: "哈尔滨", extractCity: "哈尔滨" },
  ];
  for (const sample of repeatedBriefs) {
    const rules = buildDraft(sample.brief, { id: "fix-repeat-rules", now, random });
    if (rules.city !== sample.city) return `${sample.brief} 城市应为 ${sample.city}，得到 ${rules.city}`;
    const rulesRepeat = assertNoRepeatedSights(rules, `规则 ${sample.brief}`);
    if (rulesRepeat) return rulesRepeat;
    const model = bookFromExtract(looseExtract(sample.extractCity, sample.brief.includes("北京去") ? "北京" : "上海", "2026-11-10", null), sample.brief, now, "fix-repeat-model");
    if (typeof model === "string") return `${sample.brief} ${model}`;
    const modelRepeat = assertNoRepeatedSights(model, `抽取 ${sample.brief}`);
    if (modelRepeat) return modelRepeat;
  }

  const xian = buildDraft("从北京去西安玩7天", { id: "fix-xian", now, random });
  const warriors = xian.items.filter((item) => item.title.includes("兵马俑"));
  if (warriors.length === 0) return "西安行程应排上兵马俑";
  if (warriors.some((item) => item.dayIndex === 1 && (parseTime(item.startTime) ?? 0) >= 12 * 60)) {
    return `兵马俑不应排在到达当天下午，得到第 ${warriors[0]?.dayIndex} 天 ${warriors.map((item) => item.startTime).join(",")}`;
  }
  const warriorMorning = warriors.find((item) => item.dayIndex > 1);
  if (!warriorMorning || (parseTime(warriorMorning.startTime) ?? 24 * 60) >= 12 * 60) {
    return `兵马俑应改到后面一天的上午，得到 ${warriors.map((item) => `第${item.dayIndex}天 ${item.startTime}`).join("、")}`;
  }
  for (const item of xian.items) {
    if (item.type !== "景点") continue;
    const start = parseTime(item.startTime);
    if (start == null || start < 12 * 60) continue;
    if (/早上|上午|凌晨/.test(item.note ?? "")) {
      return `${item.title} 在 ${item.startTime} 仍写着早上或上午：${item.note}`;
    }
  }

  const dawnBrief = "周六早上6点从济南出发去泰山";
  const dawnRules = buildDraft(dawnBrief, { id: "fix-tai-breakfast", now, random });
  const dawnModel = bookFromExtract(
    {
      kind: "旅游",
      origin: "济南",
      destination: { city: "泰山", area: null },
      startDate: "2026-11-14",
      endDate: null,
      party: null,
      outbound: { date: "2026-11-14", time: "06:00", mode: null, from: "济南", to: "泰安" },
      inbound: null,
      fixed: [{ date: "2026-11-14", time: "06:00", endTime: null, title: "泰山", place: "泰山", type: "景点" }],
      lodging: null,
      interests: ["泰山"],
      pace: null,
      budget: null,
      missing: [],
    },
    dawnBrief,
    now,
    "fix-tai-breakfast-dirty",
  );
  if (typeof dawnModel === "string") return dawnModel;
  for (const [label, book] of [
    ["规则", dawnRules],
    ["抽取", dawnModel],
  ] as const) {
    const lateBreakfast = book.items.find((item) => item.dayIndex === 1 && item.title.includes("早餐") && (parseTime(item.startTime) ?? 0) >= 12 * 60);
    if (lateBreakfast) return `${label} 泰山不应把早餐放到 ${lateBreakfast.startTime}`;
    const depart = book.items.find((item) => item.type === "交通" && item.title.includes("前往"));
    const departAt = parseTime(depart?.startTime ?? "") ?? 0;
    const arrived = departAt + (depart?.durationMinutes ?? 0);
    const climb = book.items.find((item) => item.type === "景点" && item.title.includes("泰山"));
    const climbAt = parseTime(climb?.startTime ?? "") ?? 0;
    const breakfast = book.items.find((item) => item.dayIndex === 1 && item.title.includes("早餐"));
    if (!breakfast) return `${label} 早到之后应吃早餐，而不是直接开爬`;
    const at = parseTime(breakfast.startTime) ?? 0;
    if (at < arrived || at < 7 * 60) {
      return `${label} 早餐应在到达之后，并且不早于 07:00，得到 ${breakfast.place} ${breakfast.startTime}`;
    }
    if (arrived <= 7 * 60 && at !== 7 * 60) {
      return `${label} 到达早于 07:00 时早餐应在 07:00，得到 ${breakfast.startTime}`;
    }
    if (at + breakfast.durationMinutes !== climbAt) {
      return `${label} 开爬应紧接早餐，得到 ${breakfast.startTime}+${breakfast.durationMinutes} 爬 ${climb?.startTime}`;
    }
    const climbEnd = climbAt + (climb?.durationMinutes ?? 0);
    const after = book.items.filter((item) => item.dayIndex === 1 && item.type === "餐" && (parseTime(item.startTime) ?? 0) >= climbEnd);
    if (after.some((item) => item.title.includes("早餐"))) return `${label} 爬完不应再叫早餐`;
  }

  const statedBackBrief = "下周三到周五从北京去成都出差，晚上8点返程";
  const statedBack = buildDraft(statedBackBrief, { id: "fix-cd-stated", now, random });
  const statedRide = statedBack.items.find(
    (item) => item.type === "交通" && item.title.includes("成都") && item.title.includes("北京") && item.startTime === "20:00",
  );
  if (!statedRide || statedRide.startTime !== "20:00" || !statedRide.locked) {
    return `晚上8点返程应锁在 20:00，得到 ${statedRide?.startTime} locked=${statedRide?.locked}`;
  }
  if (statedRide.travelEstimateMinutes !== 445 || statedRide.durationMinutes !== 445) {
    return `晚上8点返程不应缩短，得到日历 ${statedRide.durationMinutes} 估计 ${statedRide.travelEstimateMinutes}`;
  }
  if (!statedRide.note?.includes("预计次日 03:25 到")) {
    return `晚上8点返程应注明预计次日 03:25 到，而不是把时长收成 330，得到 ${statedRide.durationMinutes} ${statedRide.note}`;
  }

  const blockedBrief = "下周三到周五从北京去成都出差，周五下午2点开会";
  const blocked = buildDraft(blockedBrief, { id: "fix-cd-blocked", now, random });
  const blockedMeet = blocked.items.find((item) => item.title.includes("开会"));
  const blockedRide = blocked.items.find((item) => item.type === "交通" && item.title === "返回北京");
  if (!blockedMeet || blockedMeet.dayIndex !== 3 || blockedMeet.startTime !== "14:00" || !blockedMeet.locked) {
    return `返程日开会应锁在第 3 天 14:00，得到第 ${blockedMeet?.dayIndex} 天 ${blockedMeet?.startTime} locked=${blockedMeet?.locked}`;
  }
  if (!blockedRide || blockedRide.startTime !== "18:00" || blockedRide.durationMinutes !== 445 || blockedRide.travelEstimateMinutes !== 445) {
    return `开会挤掉全段时应退回 18:00 且不缩短，得到 ${blockedRide?.startTime} ${blockedRide?.durationMinutes}/${blockedRide?.travelEstimateMinutes}`;
  }
  if (!blockedRide.note?.includes("预计次日 01:25 到")) return `退回的返程应注明次日到达：${blockedRide.note}`;

  const playBrief = "下周三到周五从北京去成都";
  const play = buildDraft(playBrief, { id: "fix-cd-play", now, random });
  const playBack = play.items.find((item) => item.type === "交通" && item.title === "返回北京");
  if (playBack?.startTime !== "16:00") return `游玩京蓉返程应为 16:00，得到 ${playBack?.startTime}`;
  if (!playBack.note?.includes("已拿掉") && !play.statusLine.includes("已拿掉") && !play.assumptions.some((item) => item.detail?.includes("已拿掉"))) {
    return "提前返程挤掉傍晚安排时应写明已拿掉";
  }

  const longHauls = [
    { brief: "从广州去哈尔滨玩3天", from: "广州", to: "哈尔滨", origin: "广州", city: "哈尔滨" },
    { brief: "从上海去乌鲁木齐玩3天", from: "上海", to: "乌鲁木齐", origin: "上海", city: "乌鲁木齐" },
    { brief: "从上海去东京玩3天", from: "上海", to: "东京", origin: "上海", city: "东京" },
  ];
  for (const hop of longHauls) {
    const rules = buildDraft(hop.brief, { id: "fix-long-rules", now, random });
    const model = bookFromExtract(
      looseExtract(hop.city, hop.origin, "2026-11-10", null, {
        outbound: { date: "2026-11-10", time: null, mode: null, from: null, to: null },
        inbound: { date: null, time: null, mode: null, from: null, to: null },
      }),
      hop.brief,
      now,
      "fix-long-model",
    );
    if (typeof model === "string") return `${hop.brief} ${model}`;
    for (const [label, book] of [
      ["规则", rules],
      ["抽取", model],
    ] as const) {
      const out = book.items.find((item) => item.type === "交通" && item.title.includes(hop.from) && item.title.includes(hop.to));
      const back = book.items.find((item) => item.type === "交通" && item.title === `返回${hop.origin}`);
      if (!out || out.durationMinutes !== 300 || out.travelEstimateMinutes !== 300 || out.estimateSource !== "推断") {
        return `${label} ${hop.brief} 应推断约 300 分钟，而不是 120，得到 ${out?.durationMinutes}/${out?.travelEstimateMinutes} ${out?.estimateSource}`;
      }
      if (!back || back.durationMinutes !== 300 || back.travelEstimateMinutes !== 300 || back.estimateSource !== "推断") {
        return `${label} ${hop.brief} 返程应同为 300 分钟推断，得到 ${back?.durationMinutes}/${back?.travelEstimateMinutes}`;
      }
    }
  }
  const flightBrief = "从上海坐飞机去东京，玩3天";
  const flightRules = buildDraft(flightBrief, { id: "fix-tyo-flight", now, random });
  const flightOut = flightRules.items.find((item) => item.type === "交通" && item.title.includes("东京"));
  if (!flightOut || flightOut.durationMinutes !== 300 || flightOut.travelEstimateMinutes !== 300) {
    return `写明飞机的上海到东京应是 300 分钟，得到 ${flightOut?.durationMinutes}/${flightOut?.travelEstimateMinutes}`;
  }
  const flightModel = bookFromExtract(
    looseExtract("东京", "上海", "2026-11-10", null, {
      outbound: { date: "2026-11-10", time: null, mode: "飞机", from: "上海", to: "东京" },
    }),
    flightBrief,
    now,
    "fix-tyo-flight-model",
  );
  if (typeof flightModel === "string") return flightModel;
  const flightModelOut = flightModel.items.find((item) => item.type === "交通" && item.title.includes("东京"));
  if (!flightModelOut || flightModelOut.durationMinutes !== 300 || flightModelOut.estimateSource !== "推断") {
    return `抽取写明飞机的东京应是 300 分钟推断，得到 ${flightModelOut?.durationMinutes} ${flightModelOut?.estimateSource}`;
  }
  return null;
}

function applySpoken(book: Roadbook, text: string, id: string, random: () => string, now: Date): { book: Roadbook; note: string } | string {
  const plan = planMessage(book, text, random, now);
  if (!plan.request) return plan.note || `${text} 没有生效`;
  if (plan.note.includes("重叠的项会顺一下") || (plan.request.statusNote ?? "").includes("重叠的项会顺一下")) {
    return `${text} 仍说重叠的项会顺一下：${plan.note}`;
  }
  const applied = applyPatch(book, { ...plan.request, id });
  if (!applied.ok) return applied.error;
  return { book: applied.book, note: plan.note };
}

function assertUserFixes(): string | null {
  const now = new Date("2026-11-09T02:00:00.000Z");
  let n = 0;
  const random = () => `u${(n += 1)}`;
  const spillAfter = (book: Roadbook, day: number, cutoff: string, keep: Set<string>) =>
    book.items.filter((item) => {
      if (item.dayIndex !== day || keep.has(item.id)) return false;
      const start = parseTime(item.startTime) ?? 0;
      return start >= (parseTime(cutoff) ?? 0) || start + item.durationMinutes > (parseTime(cutoff) ?? 0);
    });

  const wuzhen = buildDraft("周六从杭州去乌镇", { id: "u1-wz", now, random });
  const museum = wuzhen.items.find((item) => item.title.includes("博物馆"));
  const wuzhenPlan = applySpoken(wuzhen, "把返程改到16:00", "p_u1_wz", random, now);
  if (typeof wuzhenPlan === "string") return `乌镇返程：${wuzhenPlan}`;
  const wuzhenBack = wuzhenPlan.book.items.find((item) => item.title === "返回杭州");
  const wuzhenStation = wuzhenPlan.book.items.find((item) => item.dayIndex === wuzhenBack?.dayIndex && item.title === "去车站");
  if (wuzhenBack?.startTime !== "16:00" || !wuzhenBack.locked) {
    return `乌镇返程应钉在 16:00，得到 ${wuzhenBack?.startTime} locked=${wuzhenBack?.locked}`;
  }
  if (wuzhenBack.source.kind !== "实测" || wuzhenBack.source.note !== "你改的时间") {
    return `改过的返程应标实测和你改的时间，得到 ${wuzhenBack.source.kind} ${wuzhenBack.source.note}`;
  }
  if (wuzhenBack.note?.includes("原话没提返程")) return `改过的返程不应再写原话没提：${wuzhenBack.note}`;
  if (!wuzhenBack.note?.includes("你改")) return `改过的返程应写明钟点是你改的：${wuzhenBack.note}`;
  const wuzhenReturnTag = wuzhenPlan.book.assumptions.find((item) => item.key === "return");
  if (wuzhenReturnTag?.inferred || wuzhenReturnTag?.value !== "你改到第 3 天 16:00") {
    return `返程假设应是你改到第 3 天 16:00，得到 ${wuzhenReturnTag?.value} inferred=${wuzhenReturnTag?.inferred}`;
  }
  const askDays = planMessage(wuzhenPlan.book, "改成2天", random, now);
  if (askDays.request) return "锁定返程后改成 2 天应先问，不应直接挪";
  if (!askDays.note.includes("要先改返程吗")) return `锁定返程后改天数应先问：${askDays.note}`;
  if (wuzhenStation?.startTime !== "15:00") return `乌镇去车站应在 15:00，得到 ${wuzhenStation?.startTime}`;
  const wuzhenSpill = spillAfter(
    wuzhenPlan.book,
    wuzhenBack.dayIndex,
    "15:00",
    new Set([wuzhenBack.id, wuzhenStation?.id ?? ""]),
  );
  if (wuzhenSpill.length > 0) {
    return `16:00 返程前不该再压着：${wuzhenSpill.map((item) => `${item.title} ${item.startTime}`).join("、")}`;
  }
  const wuzhenRemoved = wuzhen.items.filter((item) => !wuzhenPlan.book.items.some((next) => next.id === item.id));
  for (const item of wuzhenRemoved) {
    if (!wuzhenPlan.note.includes(item.title)) return `乌镇提示应点名 ${item.title}：${wuzhenPlan.note}`;
  }
  if (museum && wuzhenRemoved.some((item) => item.id === museum.id) && !wuzhenPlan.note.includes("博物馆")) {
    return `乌镇应点名拿掉博物馆：${wuzhenPlan.note}`;
  }

  const beijing = buildDraft("从上海去北京玩2天", { id: "u1-bj", now, random });
  const tiantan = beijing.items.find((item) => item.title.includes("天坛"));
  const beijingPlan = applySpoken(beijing, "把返程改到14:00", "p_u1_bj", random, now);
  if (typeof beijingPlan === "string") return `北京返程：${beijingPlan}`;
  const beijingBack = beijingPlan.book.items.find((item) => item.title === "返回上海");
  const beijingStation = beijingPlan.book.items.find((item) => item.dayIndex === beijingBack?.dayIndex && item.title === "去车站");
  if (beijingBack?.startTime !== "14:00" || !beijingBack.locked) {
    return `北京返程应钉在 14:00，得到 ${beijingBack?.startTime} locked=${beijingBack?.locked}`;
  }
  if (beijingStation?.startTime !== "13:00") return `北京去车站应在 13:00，得到 ${beijingStation?.startTime}`;
  const beijingSpill = spillAfter(
    beijingPlan.book,
    beijingBack.dayIndex,
    "13:00",
    new Set([beijingBack.id, beijingStation?.id ?? ""]),
  );
  if (beijingSpill.length > 0) {
    return `14:00 返程前不该再压着：${beijingSpill.map((item) => `${item.title} ${item.startTime}`).join("、")}`;
  }
  if (tiantan && !beijingPlan.book.items.some((item) => item.id === tiantan.id) && !beijingPlan.note.includes("天坛")) {
    return `北京提示应点名天坛：${beijingPlan.note}`;
  }
  if (beijingPlan.book.items.some((item) => item.title.includes("天坛") && item.dayIndex === beijingBack.dayIndex && (parseTime(item.startTime) ?? 0) >= 13 * 60)) {
    return "天坛不应留在 14:00 的返程之后";
  }

  const lockedHost = buildDraft("周六从杭州去乌镇", { id: "u1-lock", now, random });
  const lockedBack = lockedHost.items.find((item) => item.title === "返回杭州");
  const lockedSight = lockedHost.items.find((item) => item.type === "景点" && item.dayIndex === lockedBack?.dayIndex);
  if (!lockedBack || !lockedSight) return "锁定冲突用例缺少返程或景点";
  const lockedSetup = applyPatch(lockedHost, {
    id: "p_u1_lock_setup",
    label: "锁定景点",
    kind: "user",
    ops: [
      { op: "update", id: lockedSight.id, fields: { startTime: "16:00", durationMinutes: 60 } },
      { op: "update", id: lockedSight.id, fields: { locked: true } },
    ],
  });
  if (!lockedSetup.ok) return `锁定景点失败：${lockedSetup.error}`;
  const refused = planMessage(lockedSetup.book, "把返程改到16:00", random, now);
  if (refused.request) return "已锁定的景点挡住返程时，不应改点";
  if (!refused.note.includes(lockedSight.title) || !refused.note.includes("锁定") || !refused.note.includes("冲突")) {
    return `锁定冲突的提示不对：${refused.note}`;
  }
  if (lockedSetup.book.items.find((item) => item.id === lockedBack.id)?.startTime !== lockedBack.startTime) {
    return "拒绝改点后返程不应被挪后";
  }

  const chengduBrief = "下周三到周五从北京去成都出差，周四下午2点开会";
  const chengdu = buildDraft(chengduBrief, { id: "u2-cd", now, random });
  const inferred = chengdu.items.find((item) => item.title === "返回北京");
  if (inferred?.startTime !== "16:00" || inferred.locked || inferred.durationMinutes !== 445) {
    return `前置推断返程应是未锁定的 16:00 / 445，得到 ${inferred?.startTime} ${inferred?.durationMinutes} locked=${inferred?.locked}`;
  }
  const later = applySpoken(chengdu, "把返程改到18:00", "p_u2_18", random, now);
  if (typeof later === "string") return `成都改到 18:00：${later}`;
  const laterRide = later.book.items.find((item) => item.id === inferred.id);
  if (laterRide?.startTime !== "18:00" || laterRide.durationMinutes !== 445 || laterRide.travelEstimateMinutes !== 445) {
    return `18:00 推断返程应保持 445，得到 ${laterRide?.startTime} ${laterRide?.durationMinutes}/${laterRide?.travelEstimateMinutes}`;
  }
  if (!laterRide.note?.includes("预计次日 01:25 到")) return `18:00 应注明预计次日 01:25 到：${laterRide?.note}`;
  const barEnd = Math.min((parseTime(laterRide.startTime) ?? 0) + laterRide.durationMinutes, 23 * 60 + 59);
  if (barEnd !== 23 * 60 + 59) return `横条应只画到 23:59，得到 ${formatTime(barEnd)}`;

  const stated = buildDraft("下周三到周五从北京去成都出差，晚上8点返程", { id: "u5-cd", now, random });
  const toNine = applySpoken(stated, "把返程改到21:00", "p_u5_21", random, now);
  if (typeof toNine === "string") return `改到 21:00：${toNine}`;
  const nine = toNine.book.items.find((item) => item.type === "交通" && item.startTime === "21:00" && item.title.includes("北京"));
  if (!nine || nine.durationMinutes !== 445 || nine.travelEstimateMinutes !== 445) {
    return `21:00 返程不应缩短，得到 ${nine?.startTime} ${nine?.durationMinutes}/${nine?.travelEstimateMinutes}`;
  }
  if (!nine.note?.includes("预计次日 04:25 到") || nine.note.includes("03:25")) {
    return `21:00 应改成预计次日 04:25 到：${nine.note}`;
  }
  const earlier = applySpoken(toNine.book, "把返程改到16:00", "p_u5_16", random, now);
  if (typeof earlier === "string") return `改回 16:00：${earlier}`;
  const earlyRide = earlier.book.items.find((item) => item.id === nine.id);
  if (earlyRide?.startTime !== "16:00" || earlyRide.durationMinutes !== 445) {
    return `16:00 仍应是整段 445，得到 ${earlyRide?.startTime} ${earlyRide?.durationMinutes}`;
  }
  if (earlyRide.note?.includes("预计次日")) return `16:00 当天能到，应去掉次日到达：${earlyRide.note}`;

  const shrink = applySpoken(chengdu, "改成2天", "p_u3_2", random, now);
  if (typeof shrink === "string") return `成都改成 2 天：${shrink}`;
  const meeting = shrink.book.items.find((item) => item.title.includes("开会"));
  const shrunkRide = shrink.book.items.find((item) => item.title === "返回北京");
  const shrunkStation = shrink.book.items.find((item) => item.title === "去车站");
  if (!meeting || meeting.dayIndex !== 2 || meeting.startTime !== "14:00" || !meeting.locked) {
    return `开会应仍锁在第 2 天 14:00，得到第 ${meeting?.dayIndex} 天 ${meeting?.startTime}`;
  }
  if (!shrunkRide || shrunkRide.dayIndex !== 2 || shrunkRide.startTime !== "18:00" || shrunkRide.durationMinutes !== 445) {
    return `改成 2 天应把返程退到第 2 天 18:00 且不缩短，得到第 ${shrunkRide?.dayIndex} 天 ${shrunkRide?.startTime} ${shrunkRide?.durationMinutes}`;
  }
  if (shrunkRide.travelEstimateMinutes !== 445 || !shrunkRide.note?.includes("预计次日 01:25 到")) {
    return `退回的返程应注明次日 01:25：${shrunkRide.travelEstimateMinutes} ${shrunkRide.note}`;
  }
  if (shrunkStation?.dayIndex !== 2 || shrunkStation.startTime !== "17:00") {
    return `去车站应跟着到第 2 天 17:00，得到第 ${shrunkStation?.dayIndex} 天 ${shrunkStation?.startTime}`;
  }

  const leisure = buildDraft("从北京去成都玩3天", { id: "u3-play", now, random });
  const leisureSample = leisure.items.find((item) => item.type === "餐") ?? leisure.items[0];
  if (!leisureSample) return "游玩京蓉缺少可复制的行程项";
  const withMeeting = applyPatch(leisure, {
    id: "p_u3_meet",
    label: "加开会",
    kind: "user",
    ops: [
      {
        op: "add",
        item: {
          ...leisureSample,
          id: "i_u3_meet",
          dayIndex: 2,
          startTime: "14:00",
          durationMinutes: 120,
          title: "开会",
          type: "办事",
          locked: true,
          priority: "必去",
          note: "来自你的原话。",
        },
      },
    ],
  });
  if (!withMeeting.ok) return `游玩行程加开会失败：${withMeeting.error}`;
  const leisureTwo = applySpoken(withMeeting.book, "改成2天", "p_u3_play2", random, now);
  if (typeof leisureTwo === "string") return `游玩改成 2 天：${leisureTwo}`;
  const leisureRide = leisureTwo.book.items.find((item) => item.title === "返回北京");
  const leisureStation = leisureTwo.book.items.find((item) => item.dayIndex === 2 && item.title === "去车站");
  const leisureMeet = leisureTwo.book.items.find((item) => item.id === "i_u3_meet");
  if (!leisureMeet || leisureMeet.startTime !== "14:00" || !leisureMeet.locked) return "游玩开会应留在 14:00";
  if (!leisureRide || leisureRide.dayIndex !== 2 || leisureRide.startTime !== "18:00" || leisureRide.durationMinutes !== 445) {
    return `游玩改成 2 天返程应为 18:00 / 445，得到第 ${leisureRide?.dayIndex} 天 ${leisureRide?.startTime} ${leisureRide?.durationMinutes}`;
  }
  if (leisureStation?.startTime !== "17:00") return `游玩去车站应为 17:00，得到 ${leisureStation?.startTime}`;

  const lengthened = applySpoken(chengdu, "改成4天", "p_u4_4", random, now);
  if (typeof lengthened === "string") return `成都改成 4 天：${lengthened}`;
  if (lengthened.book.items.some((item) => item.title.startsWith("返回") || item.title === "去车站")) {
    return `超过 3 天应去掉推断返程和去车站：${lengthened.book.items
      .filter((item) => item.title.startsWith("返回") || item.title === "去车站")
      .map((item) => item.title)
      .join("、")}`;
  }
  const droppedTag = lengthened.book.assumptions.find((item) => item.key === "return");
  if (!droppedTag?.value.includes("这次不补")) return `推断返程去掉后应写这次不补：${droppedTag?.value}`;

  const su = buildDraft("从上海去苏州玩2天", { id: "u4-su", now, random });
  const suFour = applySpoken(su, "改成4天", "p_u4_su", random, now);
  if (typeof suFour === "string") return `苏州改成 4 天：${suFour}`;
  if (suFour.book.items.some((item) => item.title.startsWith("返回") || item.title === "去车站")) return "苏州超过 3 天不应留下推断返程";
  if (!suFour.book.assumptions.find((item) => item.key === "return")?.value.includes("这次不补")) return "苏州假设应写这次不补";

  const statedFour = applySpoken(stated, "改成4天", "p_u4_stated", random, now);
  if (typeof statedFour === "string") return `写明返程改成 4 天：${statedFour}`;
  const keptRide = statedFour.book.items.find((item) => item.type === "交通" && item.locked && item.title.includes("北京") && item.title.includes("成都"));
  if (!keptRide || keptRide.dayIndex !== 4 || keptRide.startTime !== "20:00") {
    return `写明的返程应留在第 4 天 20:00，得到第 ${keptRide?.dayIndex} 天 ${keptRide?.startTime} ${keptRide?.title}`;
  }
  if (statedFour.book.assumptions.some((item) => item.value.includes("这次不补"))) return "写明的返程不应说这次不补";

  const fridayBrief = "下周三到周五从北京去成都出差，周五下午5点开会";
  const missingOut = bookFromExtract(
    {
      kind: "办事",
      origin: "北京",
      destination: { city: "成都", area: null },
      startDate: "2026-11-18",
      endDate: "2026-11-20",
      party: null,
      outbound: null,
      inbound: null,
      fixed: [{ date: "2026-11-20", time: "17:00", endTime: null, title: "开会", place: "成都", type: "办事" }],
      lodging: null,
      interests: [],
      pace: null,
      budget: null,
      missing: [],
    },
    fridayBrief,
    now,
    "u-out-missing",
  );
  if (typeof missingOut === "string") return missingOut;
  const filledOut = missingOut.items.find((item) => item.dayIndex === 1 && item.type === "交通" && item.title.includes("前往"));
  if (!filledOut || filledOut.startTime !== "08:00" || filledOut.locked) {
    return `没写去程时应补第 1 天 08:00 且不锁定，得到 ${filledOut?.title ?? "无"} ${filledOut?.startTime} locked=${filledOut?.locked}`;
  }
  const fridayMeet = missingOut.items.find((item) => item.title.includes("开会"));
  if (!fridayMeet || fridayMeet.dayIndex !== 3 || fridayMeet.startTime !== "17:00") {
    return `周五开会应留在第 3 天 17:00，得到第 ${fridayMeet?.dayIndex} 天 ${fridayMeet?.startTime}`;
  }
  const stolenOut = bookFromExtract(
    {
      kind: "办事",
      origin: "北京",
      destination: { city: "成都", area: null },
      startDate: "2026-11-18",
      endDate: "2026-11-20",
      party: null,
      outbound: { date: "2026-11-20", time: "17:00", mode: null, from: "北京", to: "成都" },
      inbound: null,
      fixed: [{ date: "2026-11-20", time: "17:00", endTime: null, title: "开会", place: "成都", type: "办事" }],
      lodging: null,
      interests: [],
      pace: null,
      budget: null,
      missing: [],
    },
    fridayBrief,
    now,
    "u-out-stolen",
  );
  if (typeof stolenOut === "string") return stolenOut;
  const repaired = stolenOut.items.find((item) => item.type === "交通" && item.title.includes("前往") && item.title.includes("成都"));
  if (!repaired || repaired.dayIndex !== 1 || repaired.startTime !== "08:00" || repaired.locked) {
    return `开会钟点写进去程时应改回第 1 天 08:00，得到第 ${repaired?.dayIndex} 天 ${repaired?.startTime} locked=${repaired?.locked}`;
  }
  const keptOutBook = bookFromExtract(
    {
      kind: "办事",
      origin: "北京",
      destination: { city: "成都", area: null },
      startDate: "2026-11-18",
      endDate: "2026-11-20",
      party: null,
      outbound: { date: "2026-11-18", time: "07:30", mode: "高铁", from: "北京", to: "成都" },
      inbound: null,
      fixed: [{ date: "2026-11-20", time: "17:00", endTime: null, title: "开会", place: "成都", type: "办事" }],
      lodging: null,
      interests: [],
      pace: null,
      budget: null,
      missing: [],
    },
    fridayBrief,
    now,
    "u-out-kept",
  );
  if (typeof keptOutBook === "string") return keptOutBook;
  const keptOut = keptOutBook.items.find((item) => item.type === "交通" && item.title.includes("前往") && item.title.includes("成都"));
  if (!keptOut || keptOut.dayIndex !== 1 || keptOut.startTime !== "07:30") {
    return `已经正确的去程应留在第 1 天 07:30，得到第 ${keptOut?.dayIndex} 天 ${keptOut?.startTime}`;
  }

  const dawn = buildDraft("周六早上6点从济南出发去泰山", { id: "u6-tai", now, random });
  const dawnRide = dawn.items.find((item) => item.type === "交通" && item.title.includes("前往"));
  const dawnClimb = dawn.items.find((item) => item.type === "景点" && item.title.includes("泰山"));
  if (!dawnRide || dawnRide.startTime !== "06:00" || !dawnClimb) return "泰山早出发用例缺少去程或爬山";
  const arrived = (parseTime(dawnRide.startTime) ?? 0) + dawnRide.durationMinutes;
  if (arrived < 6 * 60 + 20 || arrived > 6 * 60 + 50) return `到达应约 06:35，得到 ${formatTime(arrived)}`;
  const breakfast = dawn.items.find((item) => item.dayIndex === 1 && (item.title.includes("早餐") || item.title.includes("早饭")));
  if (!breakfast) return "早到之后应先吃早餐";
  const breakfastAt = parseTime(breakfast.startTime) ?? 0;
  if (breakfastAt < arrived || breakfastAt < 7 * 60) {
    return `早餐应在到达之后且不早于 07:00，得到 ${breakfast.place} ${breakfast.startTime}`;
  }
  if (arrived <= 7 * 60 && breakfastAt !== 7 * 60) return `到达早于 07:00 时早餐应在 07:00，得到 ${breakfast.startTime}`;
  const climbAt = parseTime(dawnClimb.startTime) ?? 0;
  if (climbAt !== breakfastAt + breakfast.durationMinutes) {
    return `开爬应紧接早餐，得到 ${breakfast.startTime}+${breakfast.durationMinutes} 爬 ${dawnClimb.startTime}`;
  }
  const climbEnd = climbAt + dawnClimb.durationMinutes;
  if (dawn.items.some((item) => item.dayIndex === 1 && item.type === "餐" && (parseTime(item.startTime) ?? 0) >= climbEnd && /早餐|早饭|当地早餐/.test(item.title))) {
    return "爬完不应再叫当地早餐";
  }

  const namedClimb = buildDraft("明天早上7点去爬泰山", { id: "v-stated-climb", now, random });
  const named = namedClimb.items.find((item) => item.type === "景点" && item.title.includes("泰山"));
  if (!named?.locked || named.startTime !== "07:00") return `写了 7 点的泰山应留在 07:00，得到 ${named?.startTime}`;
  const namedMeal = namedClimb.items.find((item) => item.dayIndex === 1 && /早餐|早饭/.test(item.title));
  if (namedMeal && (parseTime(namedMeal.startTime) ?? 0) + namedMeal.durationMinutes > 7 * 60) {
    return `7 点开爬之前放不下早餐就不要排，得到 ${namedMeal.startTime}`;
  }

  const wuzhenDays = buildDraft("周六从杭州去乌镇", { id: "v2-wz", now, random });
  const toFive = applySpoken(wuzhenDays, "改成5天", "p_v2_5", random, now);
  if (typeof toFive === "string") return `乌镇改成 5 天：${toFive}`;
  if (!toFive.book.assumptions.find((item) => item.key === "return")?.value.includes("这次不补")) return "改成 5 天应写这次不补";
  const backToTwo = applySpoken(toFive.book, "改成2天", "p_v2_2", random, now);
  if (typeof backToTwo === "string") return `乌镇再改成 2 天：${backToTwo}`;
  const restored = backToTwo.book.items.find((item) => item.title === "返回杭州");
  if (!restored || restored.dayIndex !== 2) return `短途应把返程补回第 2 天，得到第 ${restored?.dayIndex} 天`;
  const restoredTag = backToTwo.book.assumptions.find((item) => item.key === "return");
  const restoredClock = restored.startTime;
  if (restoredTag?.value !== `没写，按第 2 天 ${restoredClock} 估`) {
    return `补回返程后应刷新这次不补：${restoredTag?.value}，实际 ${restoredClock}`;
  }
  if (!restoredTag.inferred) return "补回的返程估计应重新标成推断";
  const handTag = wuzhenDays.assumptions.find((item) => item.key === "return");
  if (!handTag) return "乌镇缺少返程假设";
  const handPlan = planAssumptionEdit(wuzhenDays, handTag.id, "自己安排", random, now);
  if (!handPlan.request) return handPlan.note || "手改返程假设没有生效";
  const handed = applyPatch(wuzhenDays, { ...handPlan.request, id: "p_v2_hand" });
  if (!handed.ok) return handed.error;
  const handFive = applySpoken(handed.book, "改成5天", "p_v2_hand5", random, now);
  if (typeof handFive === "string") return `手改后再改 5 天：${handFive}`;
  const handTwo = applySpoken(handFive.book, "改成2天", "p_v2_hand2", random, now);
  if (typeof handTwo === "string") return `手改后再改 2 天：${handTwo}`;
  const keptHand = handTwo.book.assumptions.find((item) => item.key === "return");
  if (keptHand?.value !== "自己安排" || keptHand.detail !== "已手动修改") {
    return `手改的返程假设应保留：${keptHand?.value} / ${keptHand?.detail}`;
  }

  const beijingRest = buildDraft("从上海去北京玩2天", { id: "v3-bj", now, random });
  const beijingRetimed = applySpoken(beijingRest, "把返程改到14:00", "p_v3_14", random, now);
  if (typeof beijingRetimed === "string") return `北京改返程：${beijingRetimed}`;
  const beijingRestBack = beijingRetimed.book.items.find((item) => item.title === "返回上海");
  if (beijingRestBack?.source.note !== "你改的时间" || beijingRestBack.note?.includes("原话没提返程")) {
    return `北京返程标签没跟上：${beijingRestBack?.source.note} ${beijingRestBack?.note}`;
  }
  const beijingRestTag = beijingRetimed.book.assumptions.find((item) => item.key === "return");
  if (beijingRestTag?.inferred || beijingRestTag?.value !== `你改到第 ${beijingRestBack?.dayIndex} 天 14:00`) {
    return `北京返程假设应为你改到第 ${beijingRestBack?.dayIndex} 天 14:00，得到 ${beijingRestTag?.value}`;
  }
  const day2 = new Date(`${addDays(beijingRest.startDate, 1)}T02:00:00.000Z`);
  const tiredLocked = planTired(beijingRetimed.book, day2, random);
  if (!tiredLocked.request) return tiredLocked.note || "锁定返程后累了没有计划";
  const tiredLockedBook = applyPatch(beijingRetimed.book, { ...tiredLocked.request, id: "p_v3_tired" });
  if (!tiredLockedBook.ok) return tiredLockedBook.error;
  const lockedDepart = beijingRetimed.book.items.find(
    (item) => item.dayIndex === beijingRestBack?.dayIndex && item.title === "去车站",
  );
  const departAt = parseTime(lockedDepart?.startTime ?? beijingRestBack?.startTime ?? "") ?? 14 * 60;
  const lateRest = tiredLockedBook.book.items.find(
    (item) => item.dayIndex === beijingRestBack?.dayIndex && item.title === "坐下休息",
  );
  if (lateRest) {
    const restAt = parseTime(lateRest.startTime) ?? 0;
    if (restAt >= departAt || restAt + lateRest.durationMinutes > departAt) {
      return `休息不能排在返程出发之后，得到 ${lateRest.startTime}，出发 ${lockedDepart?.startTime ?? beijingRestBack?.startTime}`;
    }
  }
  const tiredOpen = planTired(beijingRest, day2, random);
  if (!tiredOpen.request) return tiredOpen.note || "未改的傍晚返程累了没有计划";
  const tiredOpenBook = applyPatch(beijingRest, { ...tiredOpen.request, id: "p_v3_open" });
  if (!tiredOpenBook.ok) return tiredOpenBook.error;
  const openStation = beijingRest.items.find((item) => item.dayIndex === 2 && item.title === "去车站");
  const openRest = tiredOpenBook.book.items.find((item) => item.dayIndex === 2 && item.title === "坐下休息");
  if (!openRest) return "未锁定的傍晚返程仍应能加上休息";
  if ((parseTime(openRest.startTime) ?? 0) >= (parseTime(openStation?.startTime ?? "17:00") ?? 0)) {
    return `傍晚返程的休息不应排到去车站之后，得到 ${openRest.startTime}`;
  }
  return null;
}

function highlightedIds(book: Roadbook): string[] {
  return book.items.filter((item) => item.highlight).map((item) => item.id).sort();
}

function assertMultiStepUndo(): string | null {
  const now = new Date("2026-11-14T02:00:00Z");
  let n = 0;
  const random = () => `u${(n += 1)}`;
  const draft = buildDraft("今天去西湖两天，两个人", { id: "undo-stack", now, random });
  const editable = draft.items.filter((item) => !item.locked);
  if (editable.length < 5) return `草稿可改项不足 5 个，得到 ${editable.length}`;
  const steps = editable.slice(0, 5);
  const originals = steps.map((item) => item.title);
  let book = draft;
  for (let index = 0; index < steps.length; index += 1) {
    const patched = applyPatch(book, {
      id: `p_walk_${index}`,
      label: `改 ${originals[index]}`,
      kind: "user",
      ops: [{ op: "update", id: steps[index]!.id, fields: { title: `${originals[index]}改` } }],
    });
    if (!patched.ok) return patched.error;
    book = patched.book;
    if (book.undo.length !== index + 1) return `第 ${index + 1} 步后栈深应是 ${index + 1}，得到 ${book.undo.length}`;
  }
  if (book.undo.length !== 5) return `连续 5 步后应能逐步撤销，栈深 ${book.undo.length}`;

  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const reverted = undoLast(book);
    if (!reverted.ok) return reverted.error;
    const current = reverted.book.items.find((item) => item.id === steps[index]!.id);
    if (current?.title !== originals[index]) {
      return `撤销第 ${index + 1} 步后「${originals[index]}」应回到初稿，得到 ${current?.title}`;
    }
    const marks = highlightedIds(reverted.book);
    if (marks.length !== 1 || marks[0] !== steps[index]!.id) {
      return `撤销第 ${index + 1} 步后刚改应只落在「${originals[index]}」，得到 ${marks.join(",")}`;
    }
    for (let earlier = 0; earlier < index; earlier += 1) {
      const pending = reverted.book.items.find((item) => item.id === steps[earlier]!.id);
      if (pending?.title !== `${originals[earlier]}改`) return `还没撤到的「${originals[earlier]}」被提前改回去了`;
    }
    if (reverted.book.assumptions.some((item) => item.changed)) return "没改假设时，撤销不应留下假设上的刚改";
    if (reverted.book.undo.length !== index) return `撤销后栈深应是 ${index}，得到 ${reverted.book.undo.length}`;
    book = reverted.book;
  }
  if (book.items.length !== draft.items.length) return "退回初稿时项数不一致";
  for (const item of draft.items) {
    const restored = book.items.find((entry) => entry.id === item.id);
    if (!restored) return `退回初稿时丢了「${item.title}」`;
    if (restored.title !== item.title || restored.startTime !== item.startTime || restored.locked !== item.locked) {
      return `退回初稿时「${item.title}」不一致：${restored.title} ${restored.startTime}`;
    }
  }
  if (book.patchHistory.length !== draft.patchHistory.length) return "退回初稿后不应留下后来的补丁";

  const tag = draft.assumptions.find((item) => item.key === "party" || item.key === "budget" || item.key === "pace");
  if (!tag) return "草稿缺少可改的假设标签";
  const retag = planAssumptionEdit(draft, tag.id, "刚改过的假设", () => "tag");
  if (!retag.request) return retag.note;
  const tagged = applyPatch(draft, { ...retag.request, id: "p_tag_undo" });
  if (!tagged.ok) return tagged.error;
  const renamed = applyPatch(tagged.book, {
    id: "p_after_tag",
    label: "改一项",
    kind: "user",
    ops: [{ op: "update", id: steps[0]!.id, fields: { title: "临时名" } }],
  });
  if (!renamed.ok) return renamed.error;
  const undoRename = undoLast(renamed.book);
  if (!undoRename.ok) return undoRename.error;
  if (undoRename.book.assumptions.find((item) => item.id === tag.id)?.changed) {
    return "撤销行程项时，不该把更早的假设高亮带回来";
  }
  if (!undoRename.book.items.find((item) => item.id === steps[0]!.id)?.highlight) return "撤销改名后该项应标成刚改";
  const undoTag = undoLast(undoRename.book);
  if (!undoTag.ok) return undoTag.error;
  const restoredTag = undoTag.book.assumptions.find((item) => item.id === tag.id);
  if (restoredTag?.value !== tag.value) return "撤销后假设应回到初稿";
  if (!restoredTag.changed) return "撤销假设后，刚改应落在这个标签上";
  if (undoTag.book.items.find((item) => item.id === steps[0]!.id)?.highlight) return "假设这一步不应继续高亮上一步的行程项";

  const lake = draft.items.find((item) => item.title === "西湖");
  const breakfast = draft.items.find((item) => item.type === "餐" && item.dayIndex === 1);
  if (!lake || !breakfast || lake.locked) return "锁定撤销测试缺少西湖或早餐";
  const lockedBook: Roadbook = {
    ...draft,
    items: draft.items.map((item) => (item.id === lake.id ? { ...item, locked: true } : item)),
  };
  const moved = applyPatch(lockedBook, {
    id: "p_safe",
    label: "改早餐名",
    kind: "user",
    ops: [{ op: "update", id: breakfast.id, fields: { title: "早点" } }],
  });
  if (!moved.ok) return moved.error;
  const undoneMove = undoLast(moved.book);
  if (!undoneMove.ok) return undoneMove.error;
  const lockedAfter = undoneMove.book.items.find((item) => item.id === lake.id);
  if (!lockedAfter?.locked || lockedAfter.title !== lake.title || lockedAfter.highlight) {
    return "撤销其他改动时，锁定项应原样留下";
  }
  if (undoneMove.book.items.find((item) => item.id === breakfast.id)?.title !== breakfast.title) {
    return "未锁定的早餐应能撤销";
  }
  const denied = applyPatch(undoneMove.book, {
    id: "p_deny_locked",
    label: "改锁定",
    kind: "user",
    ops: [{ op: "update", id: lake.id, fields: { title: "不该改" } }],
  });
  if (denied.ok) return "锁定项不应被补丁修改";
  const done = applyPatch(lockedBook, {
    id: "p_done_locked",
    label: "完成西湖",
    kind: "user",
    ops: [{ op: "update", id: lake.id, fields: { status: "已完成" } }],
  });
  if (!done.ok) return done.error;
  const undoneDone = undoLast(done.book);
  if (!undoneDone.ok) return undoneDone.error;
  const doneLake = undoneDone.book.items.find((item) => item.id === lake.id);
  if (!doneLake?.locked || doneLake.status !== lake.status || !doneLake.highlight) {
    return "撤销锁定项的完成状态应退回，并且仍锁定";
  }
  const blockedBook: Roadbook = {
    ...moved.book,
    items: moved.book.items.map((item) => (item.id === lake.id ? { ...item, title: "锁着的西湖" } : item)),
    undo: moved.book.undo.map((snapshot) => ({
      ...snapshot,
      items: snapshot.items.map((item) =>
        item.id === lake.id ? { ...item, title: "快照里的西湖", locked: true } : item,
      ),
    })),
  };
  const blocked = undoLast(blockedBook);
  if (blocked.ok) return "撤销不应改写仍锁定的项";
  if (blocked.error !== "「锁着的西湖」已锁定，不能改。") return blocked.error;
  if (blocked.book.items.find((item) => item.id === lake.id)?.title !== "锁着的西湖") return "拒绝撤销时不应改原路书";
  const locking = applyPatch(draft, {
    id: "p_lock_only",
    label: "锁定西湖",
    kind: "user",
    ops: [{ op: "update", id: lake.id, fields: { locked: true } }],
  });
  if (!locking.ok) return locking.error;
  const unlocked = undoLast(locking.book);
  if (!unlocked.ok) return unlocked.error;
  const unlockedLake = unlocked.book.items.find((item) => item.id === lake.id);
  if (unlockedLake?.locked || !unlockedLake?.highlight) return "撤销锁定应解除锁定并标成刚改";
  const renamedLake = applyPatch(draft, {
    id: "p_rename_lake",
    label: "改西湖",
    kind: "user",
    ops: [{ op: "update", id: lake.id, fields: { title: "西湖改" } }],
  });
  if (!renamedLake.ok) return renamedLake.error;
  const thenLocked = applyPatch(renamedLake.book, {
    id: "p_lock_after",
    label: "再锁定",
    kind: "user",
    ops: [{ op: "update", id: lake.id, fields: { locked: true } }],
  });
  if (!thenLocked.ok) return thenLocked.error;
  const skipLock: Roadbook = { ...thenLocked.book, undo: thenLocked.book.undo.slice(0, 1) };
  const refusedWhileLocked = undoLast(skipLock);
  if (refusedWhileLocked.ok) return "锁定还在时，撤销不应改它的内容";
  if (refusedWhileLocked.book.items.find((item) => item.id === lake.id)?.title !== "西湖改") {
    return "拒绝撤销时锁定项的内容应保持";
  }
  const unlockFirst = undoLast(thenLocked.book);
  if (!unlockFirst.ok) return unlockFirst.error;
  const renameBack = undoLast(unlockFirst.book);
  if (!renameBack.ok) return renameBack.error;
  if (renameBack.book.items.find((item) => item.id === lake.id)?.title !== lake.title) {
    return "先撤销锁定，再撤销改名，应回到初稿";
  }

  const removable = steps.find((item) => item.id !== lake.id);
  if (!removable) return "缺少可删除的项";
  const removed = applyPatch(draft, {
    id: "p_remove",
    label: `删除${removable.title}`,
    kind: "user",
    ops: [{ op: "remove", id: removable.id }],
  });
  if (!removed.ok) return removed.error;
  const restoredRemove = undoLast(removed.book);
  if (!restoredRemove.ok) return restoredRemove.error;
  const broughtBack = restoredRemove.book.items.find((item) => item.id === removable.id);
  if (!broughtBack?.highlight || broughtBack.title !== removable.title) return "撤销删除应把该项加回来并标成刚改";
  const dropLocked = undoLast({
    ...lockedBook,
    patchHistory: [
      ...lockedBook.patchHistory,
      { id: "p_drop_locked", at: now.toISOString(), label: "删锁定", kind: "user", ops: [] },
    ],
    undo: [
      {
        patchId: "p_drop_locked",
        items: lockedBook.items.filter((item) => item.id !== lake.id),
        assumptions: lockedBook.assumptions,
        weather: lockedBook.weather,
        verifyChecklist: lockedBook.verifyChecklist,
        title: lockedBook.title,
        city: lockedBook.city,
        startDate: lockedBook.startDate,
        question: lockedBook.question,
        statusLine: lockedBook.statusLine,
      },
    ],
  });
  if (dropLocked.ok) return "撤销不应删掉仍锁定、且不是这一步新增的项";

  let capped = draft;
  const noted = steps[0]!;
  for (let index = 0; index < UNDO_STACK_LIMIT + 5; index += 1) {
    const patched = applyPatch(capped, {
      id: `p_cap_${index}`,
      label: `备注 ${index}`,
      kind: "user",
      ops: [{ op: "update", id: noted.id, fields: { note: `v${index}` } }],
    });
    if (!patched.ok) return patched.error;
    capped = patched.book;
    const expected = Math.min(index + 1, UNDO_STACK_LIMIT);
    if (capped.undo.length !== expected) return `撤销栈应封顶 ${UNDO_STACK_LIMIT}，第 ${index + 1} 步得到 ${capped.undo.length}`;
  }
  if (capped.undo[0]?.patchId !== "p_cap_5" || capped.undo.at(-1)?.patchId !== `p_cap_${UNDO_STACK_LIMIT + 4}`) {
    return `超过上限时应丢掉最早的步骤，栈底 ${capped.undo[0]?.patchId}`;
  }
  for (let index = 0; index < UNDO_STACK_LIMIT; index += 1) {
    const reverted = undoLast(capped);
    if (!reverted.ok) return reverted.error;
    capped = reverted.book;
  }
  if (capped.undo.length !== 0) return "撤完保留的步骤后栈应为空";
  if (capped.items.find((item) => item.id === noted.id)?.note !== "v4") {
    return `最早的 5 步已被丢掉，备注应停在 v4，得到 ${capped.items.find((item) => item.id === noted.id)?.note}`;
  }
  const extra = undoLast(capped);
  if (extra.ok) return "空栈不应再撤销";

  const legacyUndo = {
    patchId: "p_legacy",
    items: draft.items.map((item) => ({ ...item, source: { ...item.source } })),
    assumptions: draft.assumptions.map((item) => ({ ...item })),
    weather: draft.weather.map((item) => ({ ...item })),
    verifyChecklist: draft.verifyChecklist.map((item) => ({ ...item, checkedAt: "should-not-stick" })),
    title: draft.title,
    city: draft.city,
    startDate: draft.startDate,
    question: draft.question,
    statusLine: draft.statusLine,
  };
  const legacy = {
    ...draft,
    items: draft.items.map((item) => (item.id === breakfast.id ? { ...item, title: "改过的早餐" } : item)),
    patchHistory: [
      ...draft.patchHistory,
      {
        id: "p_legacy",
        at: now.toISOString(),
        label: "旧补丁",
        kind: "user" as const,
        ops: [{ op: "update" as const, id: breakfast.id, fields: { title: "改过的早餐" } }],
      },
    ],
    undo: legacyUndo,
  };
  const loaded = normalizeRoadbookUndo(legacy as unknown as Roadbook);
  if (!Array.isArray(loaded.undo) || loaded.undo.length !== 1 || loaded.undo[0]?.patchId !== "p_legacy") {
    return "旧的单份 undo 应读成一层栈";
  }
  const undoneLegacy = undoLast(legacy as unknown as Roadbook);
  if (!undoneLegacy.ok) return undoneLegacy.error;
  const legacyBreakfast = undoneLegacy.book.items.find((item) => item.id === breakfast.id);
  if (legacyBreakfast?.title !== breakfast.title || !legacyBreakfast.highlight) {
    return "旧的单份快照应能撤销那一步，并标成刚改";
  }
  if (undoneLegacy.book.undo.length !== 0) return "撤销旧快照后应写成空栈";
  const stacked = applyPatch(legacy as unknown as Roadbook, {
    id: "p_after_legacy",
    label: "再改一步",
    kind: "user",
    ops: [{ op: "update", id: breakfast.id, fields: { title: "再改早餐" } }],
  });
  if (!stacked.ok) return stacked.error;
  if (
    stacked.book.undo.length !== 2 ||
    stacked.book.undo[0]?.patchId !== "p_legacy" ||
    stacked.book.undo[1]?.patchId !== "p_after_legacy"
  ) {
    return "旧快照上再改一步应堆成两层，并在保存时写成栈";
  }
  if (stacked.book.undo.some((snapshot) => snapshot.verifyChecklist.some((item) => "checkedAt" in item))) {
    return "撤销快照不应记下勾选";
  }

  const checklistBook: Roadbook = {
    ...draft,
    verifyChecklist: [
      { id: "v_keep", text: "开放时间" },
      { id: "v_drop", text: "返程票" },
    ],
  };
  const withCheck = applyPatch(
    {
      ...checklistBook,
      verifyChecklist: checklistBook.verifyChecklist.map((item) =>
        item.id === "v_keep" ? { ...item, checkedAt: "2026-11-14T01:00:00.000Z" } : item,
      ),
    } as Roadbook,
    {
      id: "p_check",
      label: "补清单",
      kind: "user",
      ops: [{ op: "update", id: breakfast.id, fields: { title: "核对早餐" } }],
      verifyAdds: ["当天天气"],
    },
  );
  if (!withCheck.ok) return withCheck.error;
  const snap = withCheck.book.undo.at(-1);
  if (!snap || snap.verifyChecklist.some((item) => "checkedAt" in item)) return "勾选不应进撤销快照";
  if (snap.verifyChecklist.map((item) => item.id).join(",") !== "v_keep,v_drop") return "撤销快照应保住清单行的 id";
  const checkedLater = {
    ...withCheck.book,
    verifyChecklist: withCheck.book.verifyChecklist
      .filter((item) => item.id !== "v_drop")
      .map((item) => (item.id === "v_keep" ? { ...item, checkedAt: "2026-11-14T03:00:00.000Z" } : item)),
  } as Roadbook;
  const undoneCheck = undoLast(checkedLater);
  if (!undoneCheck.ok) return undoneCheck.error;
  const kept = undoneCheck.book.verifyChecklist.find((item) => item.id === "v_keep") as { text?: string; checkedAt?: string } | undefined;
  const dropped = undoneCheck.book.verifyChecklist.find((item) => item.id === "v_drop");
  if (kept?.text !== "开放时间" || kept.checkedAt !== "2026-11-14T03:00:00.000Z") {
    return "撤销应保留同一条清单后来的勾选";
  }
  if (!dropped || "checkedAt" in dropped) return "撤销应恢复被拿掉的清单行，且不补勾选";
  if (undoneCheck.book.verifyChecklist.some((item) => item.text === "当天天气")) return "撤销应拿掉这一步新增的清单行";
  if (undoneCheck.book.items.find((item) => item.id === breakfast.id)?.title !== breakfast.title) {
    return "清单勾选不应挡住行程撤销";
  }
  return null;
}

type FixtureOutcome = { failed: boolean; planned: boolean; line: string };

async function runFixture(fixture: Fixture, liveMode: boolean): Promise<FixtureOutcome> {
  try {
    if (fixture.expect === "clarify") {
      const assessment = assessClarification(fixture.brief);
      if (!assessment.needsClarify || assessment.questions.length > 3) {
        return { failed: true, planned: false, line: `  x  ${fixture.id}  expected a clarify step` };
      }
      if (assessment.questions.some((question) => question.assumedId === "arrive")) {
        return { failed: true, planned: false, line: `  x  ${fixture.id}  defaulted a clock to arrival` };
      }
      return {
        failed: false,
        planned: false,
        line: `  ok ${fixture.id}  clarify ${assessment.questions.map((question) => question.id).join(",")}`,
      };
    }
    const gate = assessClarification(fixture.brief);
    if (gate.needsClarify) {
      return {
        failed: true,
        planned: false,
        line: `  x  ${fixture.id}  confirmed brief still needs clarify: ${gate.questions.map((question) => question.id).join(",")}`,
      };
    }
    const result = await runTravelAgent(fixture.brief, {
      llm: liveMode ? "auto" : "off",
      tools: liveMode ? "auto" : "stub",
    });
    const problem = checkResult(result, fixture.checks) ?? checkWeather(result, liveMode);
    if (problem) return { failed: true, planned: true, line: `  x  ${fixture.id}  ${problem}` };
    const days = result.variants[0]?.days.length ?? 0;
    return {
      failed: false,
      planned: true,
      line: `  ok ${fixture.id}  ${days} days, ${result.variants.length} plans, ${result.usage.toolCalls} tools, ${result.mode}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return { failed: true, planned: false, line: `  x  ${fixture.id}  threw: ${message}` };
  }
}

/** Live fixtures run a few at a time. Offline stays one-at-a-time so `pnpm eval` does not change. */
async function mapFixtures<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await run(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

function assertStyles(): string | null {
  const now = new Date("2026-11-01T02:00:00.000Z");
  let n = 0;
  const random = () => `st${(n += 1)}`;
  const draft = buildDraft("从上海去北京玩5天", { id: "style-book", now, random });
  if (draft.style) return "新路书不应自带风格";
  const described = describeStyles(draft, now);
  if (described.current || described.showReturn) return "主方案不应显示回到主方案";
  if (described.choices.some((choice) => !choice.enabled)) {
    return `出发前这四种风格都应能用规则版：${described.choices.map((choice) => `${choice.label}${choice.enabled ? "" : "灰"}`).join("、")}`;
  }
  const relaxed = applyRoadbookStyle(draft, "更轻松", false, now);
  if (!relaxed.ok) return relaxed.confirm ? relaxed.note : relaxed.error;
  if (relaxed.book.style !== "更轻松" || !relaxed.book.mainPlanId || (relaxed.book.mainPlans ?? []).length !== 1) {
    return "第一次换风格应记下主方案，并显示当前风格";
  }
  const savedMoney = applyRoadbookStyle(relaxed.book, "更省钱", false, now);
  if (!savedMoney.ok) return savedMoney.confirm ? savedMoney.note : savedMoney.error;
  if (savedMoney.book.style !== "更省钱") return `风格应互斥，得到 ${savedMoney.book.style}`;
  if (savedMoney.book.mainPlanId !== relaxed.book.mainPlanId) return "换成另一种风格应沿用同一份主方案";
  const moneyBlob = JSON.stringify({ items: savedMoney.book.items, statusLine: savedMoney.book.statusLine });
  if (/省了\s*\d|省了[^。\n]{0,12}元/.test(moneyBlob)) return `更省钱写出了省下的金额：${moneyBlob}`;
  const cut = draft.items.find((item) => item.priority === "可砍");
  if (cut && !savedMoney.book.items.some((item) => item.id === cut.id)) {
    return "换到更省钱应先回到主方案，可砍项不该被更轻松一起删掉";
  }
  const locked = draft.items.find((item) => item.locked) ?? draft.items.find((item) => item.type === "交通");
  if (!locked) return "应有一项用来锁定";
  const held = {
    ...draft,
    items: draft.items.map((item) => (item.id === locked.id ? { ...item, locked: true } : item)),
  };
  const rainy = applyRoadbookStyle(held, "雨天版", false, now);
  if (!rainy.ok) return rainy.confirm ? rainy.note : rainy.error;
  const stillLocked = rainy.book.items.find((item) => item.id === locked.id);
  if (!stillLocked?.locked || stillLocked.title !== locked.title || stillLocked.startTime !== locked.startTime) {
    return "换风格不应改锁定项";
  }
  const walked = applyRoadbookStyle(draft, "少走路", false, now);
  if (!walked.ok) return walked.confirm ? walked.note : walked.error;
  const back = applyRoadbookStyle(walked.book, "main", false, now);
  if (!back.ok) return back.confirm ? back.note : back.error;
  if (back.book.style || describeStyles(back.book, now).showReturn) return "回到主方案后不应再显示当前风格或回到主方案";
  const undoneReturn = undoLast(back.book);
  if (!undoneReturn.ok) return undoneReturn.error;
  if (undoneReturn.book.style !== "少走路" || !describeStyles(undoneReturn.book, now).showReturn) {
    return "撤回回到主方案后，风格和按钮应还在";
  }
  const beforeStyle = undoLast(undoneReturn.book);
  if (!beforeStyle.ok) return beforeStyle.error;
  if (beforeStyle.book.style || beforeStyle.book.mainPlanId || (beforeStyle.book.mainPlans ?? []).length !== 0) {
    return "撤销掉第一次换风格后，应丢掉主方案并清空风格";
  }
  if (describeStyles(beforeStyle.book, now).showReturn) return "撤销到换风格之前不应再显示回到主方案";

  let edited = relaxed.book;
  const meal = edited.items.find((item) => item.type === "餐" && !item.locked);
  if (!meal) return "应有一餐可以手改";
  for (let index = 0; index < 25; index += 1) {
    const patched = applyPatch(edited, {
      id: `p_style_edit_${index}`,
      label: `备注 ${index}`,
      kind: "user",
      ops: [{ op: "update", id: meal.id, fields: { note: `手改 ${index}` } }],
    });
    if (!patched.ok) return patched.error;
    edited = patched.book;
  }
  if ((edited.mainPlans ?? []).length !== 1 || edited.mainPlanId !== relaxed.book.mainPlanId) {
    return "连改 25 步后主方案快照仍应挂在当前路书上";
  }
  if (!edited.styleDirty) return "手改之后应记得还要确认";
  const blocked = applyRoadbookStyle(edited, "雨天版", false, now);
  if (blocked.ok || !blocked.confirm || blocked.note !== STYLE_CONFIRM) return "换风格前应先确认";
  const blockedHome = applyRoadbookStyle(edited, "main", false, now);
  if (blockedHome.ok || !blockedHome.confirm || blockedHome.note !== STYLE_CONFIRM) return "回到主方案前也应先确认";
  const confirmed = applyRoadbookStyle(edited, "main", true, now);
  if (!confirmed.ok) return confirmed.confirm ? confirmed.note : confirmed.error;
  if (confirmed.book.style) return "确认后应回到主方案";
  const mealAfter = confirmed.book.items.find((item) => item.id === meal.id);
  if (mealAfter?.note?.includes("手改")) return "确认回到主方案应撤掉风格之后的手改";

  const again = applyRoadbookStyle(confirmed.book, "更轻松", false, now);
  if (!again.ok) return again.confirm ? again.note : again.error;
  if (again.book.mainPlanId === relaxed.book.mainPlanId) return "回到主方案之后再换风格，应另存一份当时的主方案";

  const shareLeak = shareView({
    ...confirmed.book,
    mainPlans: [{ ...((confirmed.book.mainPlans ?? [])[0] ?? { id: "m", items: [], assumptions: [], weather: [], verifyChecklist: [], title: "", city: "", startDate: "", question: null, statusLine: "" }), statusLine: "主方案快照秘密" }],
    brief: "原话秘密标记-风格",
  });
  const shareJson = JSON.stringify(shareLeak);
  if (shareJson.includes("主方案快照秘密") || shareJson.includes("原话秘密标记-风格") || shareJson.includes("mainPlans") || shareJson.includes("ownerId")) {
    return "分享仍不应带上主方案快照或原话";
  }
  const allLocked = {
    ...draft,
    items: draft.items.map((item) => ({ ...item, locked: true, status: "已完成" as const })),
  };
  const gray = describeStyles(allLocked, now);
  if (gray.choices.some((choice) => choice.enabled)) return "没有能改的项时风格应变灰";
  return null;
}

function assertShare(): string | null {
  const now = new Date("2026-11-09T02:00:00.000Z");
  let n = 0;
  const random = () => `sh${(n += 1)}`;
  const book = buildDraft("从上海去北京玩5天", { id: "share-book", now, random });
  book.brief = "原话秘密标记-酒店体检";
  book.ownerId = "user-secret";
  book.assumptions = book.assumptions.map((item, index) => (index === 0 ? { ...item, detail: "假设秘密标记" } : item));
  const snapshot = {
    patchId: "p_old",
    items: book.items.map((item) => ({ ...item, title: "撤销快照秘密" })),
    assumptions: book.assumptions,
    weather: book.weather,
    verifyChecklist: book.verifyChecklist,
    title: book.title,
    city: book.city,
    startDate: book.startDate,
    question: null,
    statusLine: "撤销里的原话",
  };
  const leaked = {
    ...book,
    undo: [snapshot],
    verifyChecklist: book.verifyChecklist.map((item) => ({ ...item, checkedAt: "2026-11-11T00:00:00.000Z" })),
    mainSnapshot: { brief: book.brief, assumptions: book.assumptions, undo: [snapshot], ownerId: "user-secret" },
    accessKey: "owner-access-key",
    shareKey: "companion-share-key",
  };
  const view = shareView(leaked);
  const json = JSON.stringify(view);
  for (const secret of [
    "原话秘密标记-酒店体检",
    "假设秘密标记",
    "撤销快照秘密",
    "撤销里的原话",
    "user-secret",
    "owner-access-key",
    "companion-share-key",
    "checkedAt",
    "mainSnapshot",
    "verifyChecklist",
    "ownerId",
  ]) {
    if (json.includes(secret)) return `分享数据泄漏了 ${secret}`;
  }
  if ("brief" in view || "assumptions" in view || "undo" in view || "ownerId" in view) return "分享对象还留着机主字段";
  if (view.items.length === 0) return "分享应保留行程";
  if (!view.items.some((item) => item.source.kind === "实测" || item.source.kind === "推断" || item.source.kind === "检索")) {
    return "分享应保留来源标记";
  }
  const access = "owner-access-key";
  const share = "companion-share-key";
  if (classifyBookKey(share, access, share) !== "share") return "分享密钥不能当成机主密钥";
  if (classifyBookKey(access, access, share) !== "owner") return "机主密钥应能写";
  if (classifyBookKey("", access, share) !== "none") return "没有密钥不能写";
  if (classifyBookKey("nope", access, share) !== "none") return "乱写的密钥不能写";
  if (classifyBookKey(share, access, "rotated-share-key") !== "none") return "重置后旧分享密钥应失效";
  if (classifyBookKey("rotated-share-key", access, "rotated-share-key") !== "share") return "新分享密钥应只能读";
  return null;
}

function assertItemMenu(): string | null {
  const now = new Date("2026-11-09T02:00:00.000Z");
  let n = 0;
  const random = () => `m${(n += 1)}`;
  const book = buildDraft("下周末两个人从上海去苏州，想看园林。", { id: "menu", now, random });
  const sight = book.items.find((item) => item.type === "景点" && !item.locked);
  if (!sight) return "苏州草稿应有未锁定景点";
  const menu = describeItemMenu(book, sight.id, false);
  if (typeof menu === "string") return menu;
  if (menu.whyOnly) return "普通景点不应只有为什么";
  const enabled = (id: string) => menu.actions.find((action) => action.id === id)?.enabled;
  if (!enabled("swap") || !enabled("move") || !enabled("delete") || !enabled("why") || !enabled("lock")) {
    return `未锁定景点的菜单应都能点：${menu.actions.map((action) => `${action.label}${action.enabled ? "" : "灰"}`).join("、")}`;
  }
  const swapped = planItemSwap(book, sight.id);
  if (!swapped.request) return swapped.note;
  const swappedBook = applyPatch(book, { ...swapped.request, id: "p_swap" });
  if (!swappedBook.ok) return swappedBook.error;
  const nextSight = swappedBook.book.items.find((item) => item.id === sight.id);
  if (
    !nextSight ||
    nextSight.title === sight.title ||
    book.items.some((item) => item.title === nextSight.title) ||
    nextSight.source.kind !== "推断" ||
    nextSight.source.note !== "同城模板" ||
    !nextSight.highlight
  ) {
    return `换一个应换成还没排过的推断景点并标刚改，得到 ${nextSight?.title} ${nextSight?.source.kind} ${nextSight?.source.note}`;
  }
  if (swappedBook.book.undo.length !== book.undo.length + 1) return "换一个应进入撤销栈";
  const undoneSwap = undoLast(swappedBook.book);
  if (!undoneSwap.ok || undoneSwap.book.items.find((item) => item.id === sight.id)?.title !== sight.title) {
    return "撤销应换回原来的景点";
  }

  const meal = book.items.find((item) => item.type === "餐" && !item.locked);
  if (!meal) return "应有一餐";
  const moved = planItemMove(book, meal.id, "13:00");
  const spoken = planMessage(book, `把${meal.title}改到13:00`, random, now);
  if (!moved.request || !spoken.request) return moved.note || spoken.note || "挪时间没有生效";
  if (JSON.stringify(moved.request.ops) !== JSON.stringify(spoken.request.ops)) return "挪时间应走把午饭改到的同一套改动";
  const movedBook = applyPatch(book, { ...moved.request, id: "p_move_meal" });
  if (!movedBook.ok) return movedBook.error;
  const movedMeal = movedBook.book.items.find((item) => item.id === meal.id);
  if (movedMeal?.source.kind !== "实测" || movedMeal.source.note !== "你改的时间" || !movedMeal.highlight) {
    return `挪时间应标实测和你改的时间，得到 ${movedMeal?.startTime} ${movedMeal?.source.kind} ${movedMeal?.source.note}`;
  }

  const back = book.items.find((item) => item.title.startsWith("返回") && !item.locked);
  const station = book.items.find((item) => item.title === "去车站");
  if (!back || !station) return "苏州短途应有未锁定的推断返程和去车站";
  const stationMenu = describeItemMenu(book, station.id, false);
  if (typeof stationMenu === "string") return stationMenu;
  if (!stationMenu.whyOnly || stationMenu.actions.length !== 1 || stationMenu.actions[0]?.label !== "为什么安排这个") {
    return `去车站菜单应只有为什么，得到 ${stationMenu.actions.map((action) => action.label).join("、")}`;
  }
  if (planItemMove(book, station.id, "15:00").request) return "去车站不能单独挪时间";
  if (planItemDelete(book, station.id).request) return "去车站不能单独删";
  const retimed = planItemMove(book, back.id, "16:00");
  const spokenReturn = planMessage(book, "把返程改到16:00", random, now);
  if (!retimed.request || !spokenReturn.request) return retimed.note || spokenReturn.note || "返程挪时间没有生效";
  if (JSON.stringify(retimed.request.ops) !== JSON.stringify(spokenReturn.request.ops)) return "返程挪时间应等于把返程改到";
  if (JSON.stringify(retimed.request.assumptions) !== JSON.stringify(spokenReturn.request.assumptions)) {
    return "返程挪时间应带上同一套返程标签";
  }
  const removed = planItemDelete(book, back.id);
  if (!removed.request) return removed.note;
  const removedIds = removed.request.ops.flatMap((op) => (op.op === "remove" ? [op.id] : []));
  if (!removedIds.includes(back.id) || !removedIds.includes(station.id)) return "删掉推断返程应连去车站一起删";
  const removedBook = applyPatch(book, { ...removed.request, id: "p_drop_back" });
  if (!removedBook.ok) return removedBook.error;
  if (removedBook.book.items.some((item) => item.id === back.id || item.id === station.id)) return "返程和去车站应都不在了";
  const restored = undoLast(removedBook.book);
  if (!restored.ok) return restored.error;
  if (!restored.book.items.some((item) => item.id === back.id) || !restored.book.items.some((item) => item.id === station.id)) {
    return "撤销应把返程和去车站一起加回来";
  }

  const locked = planLockMust(book, sight.id);
  if (!locked.request) return locked.note;
  const lockedBook = applyPatch(book, { ...locked.request, id: "p_lock_must" });
  if (!lockedBook.ok) return lockedBook.error;
  const must = lockedBook.book.items.find((item) => item.id === sight.id);
  if (!must?.locked || must.priority !== "必去" || !must.highlight) return "锁定必去应同时锁定并标必去";
  const lockedMenu = describeItemMenu(lockedBook.book, sight.id, false);
  if (typeof lockedMenu === "string") return lockedMenu;
  if (lockedMenu.actions.some((action) => (action.id === "swap" || action.id === "move" || action.id === "delete") && action.enabled)) {
    return "锁定后不能换、挪、删";
  }
  const late = planLate(lockedBook.book, now);
  if (late.request) {
    const lateBook = applyPatch(lockedBook.book, { ...late.request, id: "p_late_lock" });
    if (!lateBook.ok) return lateBook.error;
    const still = lateBook.book.items.find((item) => item.id === sight.id);
    if (!still || still.title !== must.title || still.startTime !== must.startTime || !still.locked) return "重排不应改锁定项";
  }
  const opened = planItemUnlock(lockedBook.book, sight.id, false);
  if (!opened.request) return opened.note || "自己锁上的景点应能直接解锁";
  const openedBook = applyPatch(lockedBook.book, { ...opened.request, id: "p_unlock" });
  if (!openedBook.ok) return openedBook.error;
  const unlockedSight = openedBook.book.items.find((item) => item.id === sight.id);
  if (unlockedSight?.locked || unlockedSight?.priority !== "必去") return "解锁只取消锁定，必去还在";

  const checkupBook = buildDraft("明天早上7点在济南体检", { id: "menu-check", now, random });
  const checkup = checkupBook.items.find((item) => item.title.includes("体检") && item.locked);
  if (!checkup) return "写了钟点的体检应锁定";
  const ask = planItemUnlock(checkupBook, checkup.id, false);
  if (ask.request) return "原话里的体检解锁应先确认";
  if (!ask.note.includes("原话")) return `体检解锁提示不对：${ask.note}`;
  const yes = planItemUnlock(checkupBook, checkup.id, true);
  if (!yes.request) return yes.note;
  const yesBook = applyPatch(checkupBook, { ...yes.request, id: "p_unlock_check" });
  if (!yesBook.ok) return yesBook.error;
  const freeCheck = yesBook.book.items.find((item) => item.id === checkup.id);
  if (freeCheck?.locked || freeCheck?.priority !== checkup.priority) return "确认解锁后优先级应保持";

  const names = cityTemplateNames(book.city);
  const host = book.items.find((item) => item.type === "景点" && !item.locked) ?? sight;
  const filled: Roadbook = {
    ...book,
    items: [
      ...book.items.filter((item) => item.id === host.id || !names.includes(item.title)),
      ...names.filter((name) => name !== host.title).map((name, index) => ({
        ...host,
        id: `fill_${index}`,
        title: name,
        locked: false,
      })),
    ],
  };
  const fullMenu = describeItemMenu(filled, host.id, false);
  if (typeof fullMenu === "string") return fullMenu;
  const fullSwap = fullMenu.actions.find((action) => action.id === "swap");
  if (fullSwap?.enabled || fullSwap?.hint !== "需要模型密钥") {
    return `同城模板都排过时应变灰并提示需要模型密钥，得到 ${fullSwap?.hint ?? "无"}`;
  }
  if (planItemSwap(filled, host.id).request) return "没有候选时不应换成功";
  const withKey = describeItemMenu(filled, host.id, true);
  if (typeof withKey === "string") return withKey;
  const keyedSwap = withKey.actions.find((action) => action.id === "swap");
  if (!keyedSwap?.enabled || keyedSwap.hint) {
    return `有密钥且没有模板时换一个应可点，得到 ${keyedSwap?.enabled ? keyedSwap.hint ?? "无提示" : "灰"}`;
  }
  const modelChoice = chooseItemSwap(filled, host.id, true);
  if (modelChoice.mode !== "model") return "没有模板且有密钥时应交给模型换";
  const localSwap = planMessage(filled, modelChoice.text, random, now);
  if (localSwap.request || localSwap.note) return `换一个的模型句子被本地规则抢走了：${localSwap.note}`;
  if (!nextSight.note?.includes(`原来是「${sight.title}」`) || nextSight.note.includes(`已换成「${sight.title}」`)) {
    return `换一个的备注应写原来的名字，得到 ${nextSight.note}`;
  }
  return null;
}

function assertCredibility(): string | null {
  const now = new Date("2026-11-09T02:00:00.000Z");
  let n = 0;
  const random = () => `h${(n += 1)}`;
  const draft = buildDraft("明天早上7点去爬泰山", { id: "honest", now, random });
  if (draft.ownerId !== "me") return `新建路书应写 ownerId me，得到 ${draft.ownerId ?? "无"}`;
  const climb = draft.items.find((item) => item.title.includes("泰山"));
  if (!climb || climb.source.kind !== "实测" || climb.source.note !== "来自你的原话") {
    return `原话里的泰山应是实测，得到 ${climb?.source.kind} ${climb?.source.note}`;
  }
  const template = draft.items.find((item) => item.source.kind === "推断" && item.type === "景点" && item.id !== climb.id);
  if (template && !factMark(template).needsVerify) return `${template.title} 是模型建议，应提示需要你核实`;

  const aged = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const west = buildDraft("今天去西湖两天，两个人", { id: "honest-west", now, random });
  const lake = west.items.find((item) => item.title === "西湖");
  if (!lake) return "缺少西湖";
  const cited = citeRetrievedSights(west.items, { title: "西湖开放时间与门票", url: "https://example.com/xihu" }, aged);
  const oldLake = cited.find((item) => item.id === lake.id);
  if (!oldLake) return "检索后的西湖不见了";
  const oldMark = factMark(oldLake, now);
  if (oldMark.kind !== "检索" || !oldMark.fetchedOn || oldMark.unavailable || !oldMark.stale) {
    return `超过 30 天的检索应带来源、日期和可能过时，得到 ${oldMark.kind} ${oldMark.fetchedOn ?? ""} stale=${oldMark.stale}`;
  }
  const fresh = citeRetrievedSights(west.items, { title: "西湖开放时间与门票", url: "https://example.com/xihu" }, now.toISOString());
  const freshLake = fresh.find((item) => item.id === lake.id);
  if (!freshLake || factMark(freshLake, now).stale) return "刚取到的检索不应标可能过时";
  const missing = factMark({ ...lake, source: { kind: "检索", note: "西湖开放时间" } }, now);
  if (!missing.unavailable || missing.fetchedOn || missing.url) return "没有链接或日期的检索应标暂不可用，不要补数字";

  const freshWeather = {
    city: "泰安",
    query: "泰安",
    date: "2026-11-10",
    condition: "晴",
    tempMinC: 8,
    tempMaxC: 16,
    precipProbability: 10,
    available: true,
    note: "",
    fetchedAt: new Date(now.getTime() - 23 * 60 * 60 * 1000).toISOString(),
    sourceUrl: "https://example.com/weather",
  };
  if (weatherMark(freshWeather, now).stale || weatherMark(freshWeather, now).unavailable) return "23 小时内的预报不应过时";
  const staleWeather = { ...freshWeather, fetchedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString() };
  if (!weatherMark(staleWeather, now).stale) return "超过 24 小时的预报应标可能过时";
  const blankWeather = { ...freshWeather, available: false, tempMinC: null, tempMaxC: null, condition: "暂不可用" };
  const blank = weatherMark(blankWeather, now);
  if (!blank.unavailable || blank.summary !== "暂不可用" || /\d/.test(blank.summary)) return "缺预报应是暂不可用，不能编温度";

  const legacyItem = {
    ...climb,
    source: { kind: "推断" as const, note: "来自你的原话" },
  };
  const editedItem = {
    ...climb,
    id: "i_edited",
    title: "改过的午饭",
    startTime: "13:00",
    locked: false,
    source: { kind: "推断" as const, note: "你改的时间" },
  };
  const guessedItem = {
    ...climb,
    id: "i_guess",
    title: "午饭",
    startTime: "12:00",
    locked: false,
    source: { kind: "推断" as const, note: "时间推断" },
  };
  const legacy = {
    ...draft,
    ownerId: undefined,
    items: [legacyItem, editedItem, guessedItem],
    undo: {
      patchId: "p_old",
      items: [{ ...legacyItem, title: "快照泰山" }],
      assumptions: draft.assumptions,
      weather: draft.weather,
      verifyChecklist: draft.verifyChecklist.map((item) => ({ ...item, checkedAt: "should-not-stick" })),
      title: draft.title,
      city: draft.city,
      startDate: draft.startDate,
      question: draft.question,
      statusLine: draft.statusLine,
    },
  };
  const loaded = normalizeRoadbook(legacy as unknown as Roadbook);
  if (loaded.ownerId !== "me") return `旧路书读出来应补 ownerId me，得到 ${loaded.ownerId ?? "无"}`;
  if (loaded.id !== draft.id || loaded.title !== draft.title) return "补 ownerId 不应改路书身份";
  if (loaded.items.find((item) => item.id === climb.id)?.source.kind !== "实测") return "旧的来自你的原话应读成实测";
  if (loaded.items.find((item) => item.id === "i_edited")?.source.kind !== "实测") return "旧的你改的时间应读成实测";
  if (loaded.items.find((item) => item.id === "i_guess")?.source.kind !== "推断") return "时间推断不应被改成实测";
  const oldSnap = loaded.undo[0]?.items.find((item) => item.id === climb.id);
  if (oldSnap?.source.kind !== "实测" || oldSnap.title !== "快照泰山") return "撤销快照里的原话也应读成实测";
  if (loaded.undo.some((snapshot) => snapshot.verifyChecklist.some((item) => "checkedAt" in item))) {
    return "读入时不应把勾选留在撤销快照里";
  }
  if (loaded.items.length !== 3) return "读入旧路书不应改条目数量";

  const row = loaded.verifyChecklist[0];
  if (!row) return "草稿应有核实清单";
  const undoBefore = loaded.undo.length;
  const historyBefore = loaded.patchHistory.length;
  const checked = setChecklistChecked(loaded, row.id, true, now);
  if (!checked.ok) return checked.error;
  const marked = checked.book.verifyChecklist.find((item) => item.id === row.id);
  if (marked?.checkedAt !== now.toISOString()) return "勾选应记下 checkedAt";
  if (checked.book.undo.length !== undoBefore || checked.book.patchHistory.length !== historyBefore) {
    return "勾选不应占撤销位，也不应写成补丁";
  }
  const cleared = setChecklistChecked(checked.book, row.id, false, now);
  if (!cleared.ok) return cleared.error;
  const open = cleared.book.verifyChecklist.find((item) => item.id === row.id);
  if (!open || "checkedAt" in open) return "取消勾选应去掉 checkedAt";

  const linkedBook: Roadbook = {
    ...loaded,
    verifyChecklist: loaded.verifyChecklist.map((item, index) => (index === 0 ? { ...item, itemId: "i_guess" } : item)),
  };
  const ticked = setChecklistChecked(linkedBook, row.id, true, new Date("2026-11-14T03:00:00.000Z"));
  if (!ticked.ok) return ticked.error;
  const removed = applyPatch(ticked.book, {
    id: "p_drop_guess",
    label: "删除午饭",
    kind: "user",
    ops: [{ op: "remove", id: "i_guess" }],
  });
  if (!removed.ok) return removed.error;
  const retired = removed.book.verifyChecklist.find((item) => item.id === row.id);
  if (!retired || !checklistRowRetired(retired, removed.book.items) || retired.checkedAt !== "2026-11-14T03:00:00.000Z") {
    return "删掉关联项后清单应标相关项已删，并保留勾选";
  }
  if (removed.book.undo.at(-1)?.verifyChecklist.some((item) => "checkedAt" in item)) return "删除项的快照不应记下勾选";
  const broughtBack = undoLast(removed.book);
  if (!broughtBack.ok) return broughtBack.error;
  const restored = broughtBack.book.verifyChecklist.find((item) => item.id === row.id);
  const restoredGuess = broughtBack.book.items.find((item) => item.id === "i_guess");
  if (!restoredGuess || checklistRowRetired(restored ?? { id: row.id, text: row.text }, broughtBack.book.items)) {
    return "撤销删除后，关联项还在，不应再标相关项已删";
  }
  if (restored?.checkedAt !== "2026-11-14T03:00:00.000Z" || restored.itemId !== "i_guess") {
    return "撤销删除应留下后来的勾选和同一条关联";
  }
  return null;
}

function sameClockOps(left: { ops: unknown } | null, right: { ops: unknown } | null): boolean {
  if (!left || !right) return false;
  return JSON.stringify(left.ops) === JSON.stringify(right.ops);
}

function assertMealClock(book: Roadbook, phrase: "午饭" | "晚饭", clock: string, random: () => string, now: Date): string | null {
  const plan = planMessage(book, `把${phrase}改到 ${clock}`, random, now);
  if (!plan.request) return `${book.city}「把${phrase}改到 ${clock}」没有匹配：${plan.note || "无"}`;
  const touched = plan.request.ops.find((op) => op.op === "update" && op.fields.startTime === clock);
  const item = touched && touched.op === "update" ? book.items.find((entry) => entry.id === touched.id) : undefined;
  if (!item || item.type !== "餐") return `${book.city} 的${phrase}应改到一餐，得到 ${item?.type ?? "无"} ${item?.title ?? ""}`;
  const start = parseTime(item.startTime) ?? -1;
  const inSlot = phrase === "午饭" ? start >= 11 * 60 && start < 16 * 60 : start >= 16 * 60;
  if (!inSlot) return `${book.city} 的${phrase}匹配到了 ${item.startTime} ${item.title}`;
  const menu = planItemMove(book, item.id, clock);
  if (!sameClockOps(plan.request, menu.request) || !menu.request) return `${book.city} 的${phrase}应走挪时间的同一套改动`;
  const applied = applyPatch(book, { ...plan.request, id: `p_meal_${phrase}` });
  const viaMenu = applyPatch(book, { ...menu.request, id: `p_menu_${phrase}` });
  if (!applied.ok) return applied.error;
  if (!viaMenu.ok) return viaMenu.error;
  const spokenTime = applied.book.items.find((entry) => entry.id === item.id)?.startTime;
  const menuTime = viaMenu.book.items.find((entry) => entry.id === item.id)?.startTime;
  if (!spokenTime || spokenTime === item.startTime || spokenTime !== menuTime) {
    return `${book.city} 的${phrase}应改到 ${clock}，得到 ${spokenTime ?? "无"}`;
  }
  return null;
}

function assertWaveFixes(): string | null {
  const now = new Date("2026-11-01T02:00:00.000Z");
  let n = 0;
  const random = () => `w${(n += 1)}`;
  if (!STYLE_CONFIRM.includes("切换风格之后你改过的内容也会撤掉") || !STYLE_CONFIRM.includes("锁定的项会保留")) {
    return `确认文案应为原句加上锁定的项会保留，得到 ${STYLE_CONFIRM}`;
  }
  if (verifyCue(true, "share") !== "未核实" || verifyCue(true, "owner") !== "需要你核实" || verifyCue(false, "share") !== "") {
    return `核实文案不对：分享 ${verifyCue(true, "share")} 机主 ${verifyCue(true, "owner")}`;
  }

  const suzhou = buildDraft("下周末两个人从上海去苏州，想看园林。", { id: "wave-sz", now, random });
  const sight = suzhou.items.find((item) => item.type === "景点" && !item.locked);
  if (!sight) return "撤销锁定用例缺少景点";
  const must = planLockMust(suzhou, sight.id);
  if (!must.request) return must.note;
  const mustBook = applyPatch(suzhou, { ...must.request, id: "p_must" });
  if (!mustBook.ok) return mustBook.error;
  const undoneMust = undoLast(mustBook.book);
  if (!undoneMust.ok) return `锁定必去应能撤销：${undoneMust.error}`;
  const afterMust = undoneMust.book.items.find((item) => item.id === sight.id);
  if (afterMust?.locked || afterMust?.priority !== sight.priority || afterMust.title !== sight.title) {
    return "撤销锁定必去应恢复锁定前的优先级";
  }
  const moved = planItemMove(suzhou, sight.id, "15:00");
  if (!moved.request) return moved.note;
  const movedBook = applyPatch(suzhou, { ...moved.request, id: "p_time" });
  if (!movedBook.ok) return movedBook.error;
  const movedTime = movedBook.book.items.find((item) => item.id === sight.id)?.startTime;
  if (!movedTime || movedTime === sight.startTime) return "改时间没有生效";
  const mustAfter = planLockMust(movedBook.book, sight.id);
  if (!mustAfter.request) return mustAfter.note;
  const mustAfterBook = applyPatch(movedBook.book, { ...mustAfter.request, id: "p_must_after" });
  if (!mustAfterBook.ok) return mustAfterBook.error;
  const undoLock = undoLast(mustAfterBook.book);
  if (!undoLock.ok) return `改时间后再锁定必去，第一步撤销失败：${undoLock.error}`;
  const unlockedTime = undoLock.book.items.find((item) => item.id === sight.id);
  if (unlockedTime?.locked || unlockedTime?.priority !== sight.priority || unlockedTime.startTime !== movedTime) {
    return `撤销锁定必去应留下改过的时间，得到 ${unlockedTime?.startTime} locked=${unlockedTime?.locked} ${unlockedTime?.priority}`;
  }
  const undoTime = undoLast(undoLock.book);
  if (!undoTime.ok) return undoTime.error;
  if (undoTime.book.items.find((item) => item.id === sight.id)?.startTime !== sight.startTime) {
    return "再撤销一步应回到原来的时间";
  }
  const both = applyPatch(suzhou, {
    id: "p_edit_lock",
    label: "改并锁定",
    kind: "user",
    ops: [{ op: "update", id: sight.id, fields: { note: "同一步改过", locked: true, priority: "必去" } }],
  });
  if (!both.ok) return both.error;
  const undoneBoth = undoLast(both.book);
  if (!undoneBoth.ok) return `同一步改并锁定应能撤销：${undoneBoth.error}`;
  const restoredBoth = undoneBoth.book.items.find((item) => item.id === sight.id);
  if (restoredBoth?.locked || restoredBoth?.note === "同一步改过" || restoredBoth?.priority !== sight.priority) {
    return "撤销同一步的修改和锁定应整步退回";
  }

  const sample = suzhou.items[0];
  if (!sample) return "缺少用来拼为什么的项";
  const repeated = whyForItem({ ...sample, note: "来自你的原话。", source: { kind: "实测", note: "来自你的原话" } });
  if (repeated !== "来自你的原话。") return `为什么不应重复原话：${repeated}`;
  const runOn = whyForItem({
    ...sample,
    note: "原话没提返程，按短途补的。不回去就删掉",
    source: { kind: "推断", note: "时间推断" },
  });
  if (runOn !== "原话没提返程，按短途补的。不回去就删掉。时间推断。") return `为什么应断开并去重：${runOn}`;

  const wuzhen = buildDraft("周六从杭州去乌镇", { id: "wave-wz", now, random });
  const named = wuzhen.items.find((item) => (item.note ?? "").includes("你点名要去的地方"));
  if (!named) return "乌镇草稿应有你点名要去的地方";
  const opened = {
    ...wuzhen,
    items: wuzhen.items.map((item) => (item.id === named.id ? { ...item, locked: false } : item)),
  };
  const easy = applyRoadbookStyle(opened, "更轻松", false, now);
  if (!easy.ok) return easy.confirm ? easy.note : easy.error;
  const styledNamed = easy.book.items.find((item) => item.id === named.id);
  if (named.priority !== "必去" || named.type !== "景点" || named.durationMinutes <= 75) {
    return `点名的乌镇应是超过 75 分钟的必去景点，得到 ${named.priority} ${named.durationMinutes}`;
  }
  if (!styledNamed || styledNamed.durationMinutes !== named.durationMinutes || styledNamed.note !== named.note) {
    return `更轻松应保留必去「${named.title}」的 ${named.durationMinutes} 分钟，得到 ${styledNamed?.durationMinutes} ${styledNamed?.note ?? ""}`;
  }
  const optional = opened.items.find((item) => item.type === "景点" && item.priority !== "必去" && item.durationMinutes > 75);
  const optionalEasy = easy.book.items.find((item) => item.id === optional?.id);
  if (!optional || optionalEasy?.durationMinutes !== 75 || !optionalEasy.note?.includes("更轻松")) {
    return `更轻松仍应把非必去的长景点收到 75 分钟，得到 ${optional?.title ?? "无"} ${optionalEasy?.durationMinutes}`;
  }
  const lessWalk = applyRoadbookStyle(opened, "少走路", false, now);
  if (!lessWalk.ok) return lessWalk.confirm ? lessWalk.note : lessWalk.error;
  const walkedNamed = lessWalk.book.items.find((item) => item.id === named.id);
  const walkedOptional = lessWalk.book.items.find((item) => item.id === optional.id);
  if (!walkedNamed || walkedNamed.durationMinutes !== named.durationMinutes || walkedNamed.note !== named.note) {
    return `少走路应保留必去「${named.title}」的时长，得到 ${walkedNamed?.durationMinutes} ${walkedNamed?.note ?? ""}`;
  }
  if (walkedOptional?.durationMinutes !== 60) {
    return `少走路仍应把非必去的长景点收到 60 分钟，得到 ${walkedOptional?.title ?? "无"} ${walkedOptional?.durationMinutes}`;
  }
  const heldNamed = {
    ...wuzhen,
    items: wuzhen.items.map((item) => (item.id === named.id ? { ...item, locked: true } : item)),
  };
  const easyHeld = applyRoadbookStyle(heldNamed, "更轻松", false, now);
  const keptNamed = (easyHeld.ok ? easyHeld.book : heldNamed).items.find((item) => item.id === named.id);
  if (!keptNamed?.locked || keptNamed.durationMinutes !== named.durationMinutes || keptNamed.note !== named.note) {
    return "锁定的点名景点在更轻松里应保持原样";
  }
  if (!easyHeld.ok && (easyHeld.confirm || easyHeld.error !== "这次改不了。")) {
    return easyHeld.confirm ? easyHeld.note : easyHeld.error;
  }

  const stationRow = wuzhen.verifyChecklist.find((row) => row.text.includes("返程车站"));
  const back = wuzhen.items.find((item) => item.type === "交通" && item.title.startsWith("返回"));
  if (!stationRow?.itemId || !back || stationRow.itemId !== back.id) {
    return `返程车站应关联返程，得到 ${stationRow?.itemId ?? "无"} / ${back?.id ?? "无返程"}`;
  }
  const dropBack = planItemDelete(wuzhen, back.id);
  if (!dropBack.request) return dropBack.note;
  const withoutBack = applyPatch(wuzhen, { ...dropBack.request, id: "p_drop_back_row" });
  if (!withoutBack.ok) return withoutBack.error;
  const retiredStation = withoutBack.book.verifyChecklist.find((row) => row.id === stationRow.id);
  if (!retiredStation || !checklistRowRetired(retiredStation, withoutBack.book.items)) return "删掉返程后应标相关项已删";

  const checkup = buildDraft("明天早上7点在济南体检", { id: "wave-jn", now, random });
  const fast = checkup.verifyChecklist.find((row) => row.text.includes("空腹"));
  const exam = checkup.items.find((item) => item.title.includes("体检"));
  if (!fast?.itemId || !exam || fast.itemId !== exam.id) {
    return `体检空腹应关联体检项，得到 ${fast?.itemId ?? "无"} / ${exam?.title ?? "无体检"}`;
  }
  let examBook = checkup;
  if (exam.locked) {
    const unlock = planItemUnlock(checkup, exam.id, true);
    if (!unlock.request) return unlock.note;
    const unlockedExam = applyPatch(checkup, { ...unlock.request, id: "p_unlock_exam" });
    if (!unlockedExam.ok) return unlockedExam.error;
    examBook = unlockedExam.book;
  }
  const dropExam = planItemDelete(examBook, exam.id);
  if (!dropExam.request) return dropExam.note;
  const withoutExam = applyPatch(examBook, { ...dropExam.request, id: "p_drop_exam" });
  if (!withoutExam.ok) return withoutExam.error;
  const retiredFast = withoutExam.book.verifyChecklist.find((row) => row.id === fast.id);
  if (!retiredFast || !checklistRowRetired(retiredFast, withoutExam.book.items)) return "删掉体检后空腹行应标相关项已删";

  const beijing = buildDraft("从上海去北京玩5天", { id: "wave-bj", now, random });
  const host = beijing.items.find((item) => item.type === "景点" && !item.locked);
  if (!host) return "故宫换一个用例缺少景点";
  const palaceBook: Roadbook = {
    ...beijing,
    items: beijing.items
      .filter((item) => item.title !== "中国国家博物馆" && (item.id === host.id || item.title !== "故宫"))
      .map((item) => (item.id === host.id ? { ...item, title: "故宫" } : item)),
  };
  const palaceSwap = planItemSwap(palaceBook, host.id);
  if (!palaceSwap.request) return palaceSwap.note;
  const palaceNext = applyPatch(palaceBook, { ...palaceSwap.request, id: "p_palace" });
  if (!palaceNext.ok) return palaceNext.error;
  const museum = palaceNext.book.items.find((item) => item.id === host.id);
  if (museum?.title !== "中国国家博物馆" || !museum.note?.includes("原来是「故宫」") || museum.note.includes("已换成「故宫」")) {
    return `故宫换成国博的备注应写原来是故宫，得到 ${museum?.title} ${museum?.note}`;
  }

  const relaxed = applyRoadbookStyle(beijing, "更轻松", false, now);
  if (!relaxed.ok) return relaxed.confirm ? relaxed.note : relaxed.error;
  const lockSight = relaxed.book.items.find((item) => item.type === "景点" && !item.locked);
  if (!lockSight) return "风格锁定用例缺少景点";
  const beforeLock = { ...lockSight };
  const held = {
    ...relaxed.book,
    items: relaxed.book.items.map((item) => (item.id === lockSight.id ? { ...item, locked: true } : item)),
  };
  const walked = applyRoadbookStyle(held, "少走路", false, now);
  const walkedBook = walked.ok ? walked.book : held;
  if (!walked.ok && (walked.confirm || walked.error !== "这次改不了。")) return walked.confirm ? walked.note : walked.error;
  const stayed = walkedBook.items.find((item) => item.id === lockSight.id);
  if (
    !stayed?.locked ||
    stayed.durationMinutes !== beforeLock.durationMinutes ||
    stayed.note !== beforeLock.note ||
    stayed.title !== beforeLock.title ||
    stayed.startTime !== beforeLock.startTime
  ) {
    return `少走路不应改锁定项：${stayed?.title} ${stayed?.durationMinutes} ${stayed?.note}`;
  }
  const home = applyRoadbookStyle(walked.book, "main", false, now);
  if (!home.ok) return home.confirm ? home.note : home.error;
  const still = home.book.items.find((item) => item.id === lockSight.id);
  if (!still?.locked || still.durationMinutes !== beforeLock.durationMinutes || still.note !== beforeLock.note) {
    return "回到主方案不应改当前锁定的项";
  }
  const unlockedOther = beijing.items.find((item) => item.id !== lockSight.id && item.type === "景点" && !item.locked);
  if (unlockedOther) {
    const restored = home.book.items.find((item) => item.id === unlockedOther.id);
    if (restored?.durationMinutes !== unlockedOther.durationMinutes || restored.note !== unlockedOther.note) {
      return "未锁定的项回到主方案时应恢复快照";
    }
  }

  let edited = relaxed.book;
  const meal = edited.items.find((item) => item.type === "餐" && !item.locked);
  if (!meal) return "风格往返用例缺少一餐";
  const probe = edited.items.find((item) => item.type === "景点" && !item.locked && item.id !== meal.id);
  if (!probe) return "风格往返用例缺少可对照的景点";
  const probeBefore = beijing.items.find((item) => item.id === probe.id);
  for (let index = 0; index < 32; index += 1) {
    const patched = applyPatch(edited, {
      id: `p_wave_edit_${index}`,
      label: `备注 ${index}`,
      kind: "user",
      ops: [{ op: "update", id: meal.id, fields: { note: `手改 ${index}` } }],
    });
    if (!patched.ok) return patched.error;
    edited = patched.book;
  }
  const backMain = applyRoadbookStyle(edited, "main", true, now);
  if (!backMain.ok) return backMain.confirm ? backMain.note : backMain.error;
  const again = applyRoadbookStyle(backMain.book, "更轻松", false, now);
  if (!again.ok) return again.confirm ? again.note : again.error;
  const backAgain = applyRoadbookStyle(again.book, "main", false, now);
  if (!backAgain.ok) return backAgain.confirm ? backAgain.note : backAgain.error;
  if (backAgain.book.style) return "连改 32 步后再回到主方案应清空风格";
  const probeAfter = backAgain.book.items.find((item) => item.id === probe.id);
  if (!probeBefore || probeAfter?.durationMinutes !== probeBefore.durationMinutes || probeAfter.note !== probeBefore.note) {
    return "连改 32 步后回到主方案的内容仍是更轻松";
  }

  const realRandom = Math.random;
  Math.random = () => 0.123456789;
  try {
    const first = applyRoadbookStyle(beijing, "更轻松", false, now);
    if (!first.ok) return first.confirm ? first.note : first.error;
    const collided = applyRoadbookStyle(first.book, "main", false, now);
    if (collided.ok || collided.confirm || collided.error !== "风格没有写上。") {
      return `重复的风格补丁不应只改标记：${collided.ok ? "成功" : collided.confirm ? collided.note : collided.error}`;
    }
    if (collided.book.style !== "更轻松") return "风格补丁没写上时不应改当前风格";
  } finally {
    Math.random = realRandom;
  }

  const mealBooks = [
    suzhou,
    beijing,
    buildDraft("周六从杭州去乌镇", { id: "wave-meal", now, random }),
    buildDraft("明天早上7点在济南体检", { id: "wave-fast", now, random }),
  ];
  for (const cityBook of mealBooks) {
    const lunch = assertMealClock(cityBook, "午饭", "13:00", random, now);
    if (lunch) return lunch;
    const dinner = assertMealClock(cityBook, "晚饭", "19:00", random, now);
    if (dinner) return dinner;
    const mealItem = cityBook.items.find((item) => item.type === "餐");
    if (!mealItem) return `${cityBook.city} 缺少餐`;
    const mealMenu = describeItemMenu(cityBook, mealItem.id, true);
    if (typeof mealMenu === "string") return mealMenu;
    if (mealMenu.actions.some((action) => action.id === "swap")) return `${cityBook.city} 的餐不应出现换一个`;
    const ride = cityBook.items.find((item) => item.type === "交通" && item.title !== "去车站");
    if (ride) {
      const rideMenu = describeItemMenu(cityBook, ride.id, true);
      if (typeof rideMenu === "string") return rideMenu;
      if (rideMenu.actions.some((action) => action.id === "swap")) return `${cityBook.city} 的交通不应出现换一个`;
    }
  }
  return null;
}

function lunchOn(book: Roadbook, day: number): RoadbookItem | undefined {
  return book.items.find((item) => {
    if (item.type !== "餐" || item.dayIndex !== day) return false;
    const start = parseTime(item.startTime) ?? -1;
    return start >= 11 * 60 && start < 16 * 60;
  });
}

function breakfastOn(book: Roadbook, day: number): RoadbookItem | undefined {
  return book.items.find((item) => {
    if (item.type !== "餐" || item.dayIndex !== day) return false;
    const start = parseTime(item.startTime) ?? -1;
    return start < 11 * 60;
  });
}

function assertModelPatchParse(): string | null {
  for (const op of ["add", "update", "remove", "reorder"] as const) {
    if (!modelPatchSystem.includes(`"op":"${op}"`)) return `系统提示缺少 ${op} 的 JSON 示例`;
  }
  if (!modelPatchSystem.includes('"fields":{"title":"华清宫"')) return "update 示例应把标题放进 fields";
  const examples = opsFromUnknown({
    ops: [modelPatchExamples.add, modelPatchExamples.update, modelPatchExamples.remove, modelPatchExamples.reorder],
  });
  if ("error" in examples) return `提示里的四种补丁应能解析：${examples.error}`;
  const wrappedExample = examples.ops.find((op) => op.op === "update");
  if (!wrappedExample || wrappedExample.op !== "update" || wrappedExample.fields.title !== "华清宫" || "locked" in wrappedExample.fields) {
    return "update 示例应解析成带 fields 的补丁，并且不带 locked";
  }

  const now = new Date("2026-11-01T02:00:00.000Z");
  let n = 0;
  const random = () => `mp${(n += 1)}`;
  const book = buildDraft("杭州玩2天", { id: "patch-shape", now, random });
  const sight = book.items.find((item) => item.type === "景点" && !item.locked);
  if (!sight) return "模型补丁用例缺少未锁定景点";
  const flat = opsFromUnknown({
    ops: [
      {
        op: "update",
        id: sight.id,
        title: "华清宫",
        place: "西安 · 临潼",
        note: "平铺的备注",
        locked: true,
        highlight: true,
        extra: "不要",
      },
    ],
  });
  if ("error" in flat) return `平铺 update 应能解析：${flat.error}`;
  const flatOp = flat.ops[0];
  if (!flatOp || flatOp.op !== "update") return "平铺结果应是 update";
  if ("locked" in flatOp.fields || "highlight" in flatOp.fields || "extra" in flatOp.fields || "op" in flatOp.fields) {
    return `平铺只应留下行程字段：${Object.keys(flatOp.fields).join(",")}`;
  }
  if (flatOp.fields.title !== "华清宫" || flatOp.fields.note !== "平铺的备注" || flatOp.fields.place !== "西安 · 临潼") {
    return "平铺的标题、地点和备注应留下";
  }
  const applied = applyPatch(book, { id: "p_flat", label: "平铺", kind: "model", ops: flat.ops });
  if (!applied.ok) return applied.error;
  const flatItem = applied.book.items.find((item) => item.id === sight.id);
  if (!flatItem || flatItem.title !== "华清宫" || flatItem.locked || flatItem.note !== "平铺的备注") {
    return `平铺应改标题并忽略 locked，得到 ${flatItem?.title ?? "无"} locked=${flatItem?.locked} ${flatItem?.note ?? ""}`;
  }

  const wrapped = opsFromUnknown({
    ops: [{ op: "update", id: sight.id, fields: { title: "华清池", note: "包在 fields 里", locked: true, extra: "不要" } }],
  });
  if ("error" in wrapped) return `包在 fields 里的 update 应能解析：${wrapped.error}`;
  const wrappedOp = wrapped.ops[0];
  if (!wrappedOp || wrappedOp.op !== "update" || "locked" in wrappedOp.fields || "extra" in wrappedOp.fields) {
    return "fields 里的 locked 和多余字段应丢掉";
  }
  if (wrappedOp.fields.title !== "华清池" || wrappedOp.fields.note !== "包在 fields 里") return "fields 里的标题和备注应留下";
  const wrappedBook = applyPatch(book, { id: "p_wrapped", label: "包一层", kind: "model", ops: wrapped.ops });
  if (!wrappedBook.ok) return wrappedBook.error;
  const wrappedItem = wrappedBook.book.items.find((item) => item.id === sight.id);
  if (!wrappedItem || wrappedItem.title !== "华清池" || wrappedItem.locked || wrappedItem.note !== "包在 fields 里") {
    return `包一层的 update 应改标题并保持未锁定，得到 ${wrappedItem?.title ?? "无"} locked=${wrappedItem?.locked}`;
  }

  const empty = opsFromUnknown({ ops: [{ op: "update", id: sight.id }] });
  if (!("error" in empty) || empty.error !== "有一条补丁无法解析。") {
    return `没有字段的 update 应无法解析，得到 ${"error" in empty ? empty.error : "成功"}`;
  }

  const claimError = assertModelClaimRefusal(book, sight);
  if (claimError) return claimError;
  return null;
}

function spokenClaim(item: RoadbookItem): string {
  return `${item.source.kind}·${item.source.note ?? ""}·${item.note ?? ""}`;
}

function assertModelClaimRefusal(book: Roadbook, sight: RoadbookItem): string | null {
  const other = book.items.find((item) => item.id !== sight.id && item.type === "景点" && !item.locked);
  if (!other) return "模型补丁用例缺少第二处景点";
  const undoBefore = book.undo.length;
  const historyBefore = book.patchHistory.length;

  const flat = opsFromUnknown({
    ops: [
      {
        op: "update",
        id: sight.id,
        source: { kind: "实测", note: "来自你的原话" },
        note: "实测·来自你的原话",
      },
    ],
  });
  if ("error" in flat) return `假装实测的平铺补丁应能解析：${flat.error}`;
  const landed = applyPatch(book, { id: "p_flat_lie", label: "假装实测", kind: "model", ops: flat.ops });
  if (!landed.ok) return landed.error;
  const lied = landed.book.items.find((item) => item.id === sight.id);
  if (!lied || lied.source.kind !== "推断" || spokenClaim(lied).includes("来自你的原话") || spokenClaim(lied).includes("你改的时间")) {
    return `模型补丁不能落成实测·来自你的原话，得到 ${lied ? spokenClaim(lied) : "无"}`;
  }
  if (spokenClaim(lied).includes("实测")) return `模型补丁不应留下实测，得到 ${spokenClaim(lied)}`;

  const searched = applyPatch(book, {
    id: "p_search",
    label: "检索",
    kind: "model",
    ops: [
      {
        op: "update",
        id: sight.id,
        fields: {
          source: {
            kind: "检索",
            url: "https://example.com/xian",
            fetchedAt: "2026-11-01T00:00:00.000Z",
            note: "来自你的原话",
          },
        },
      },
    ],
  });
  if (!searched.ok) return searched.error;
  const cited = searched.book.items.find((item) => item.id === sight.id);
  if (cited?.source.kind !== "检索" || cited.source.url !== "https://example.com/xian" || !cited.source.fetchedAt) {
    return `带链接和取数时间的检索应保留，得到 ${cited?.source.kind} ${cited?.source.url ?? ""}`;
  }
  if ((cited.source.note ?? "").includes("来自你的原话") || (cited.note ?? "").includes("来自你的原话")) {
    return "检索备注里的来自你的原话也应去掉";
  }
  const bareSearch = applyPatch(book, {
    id: "p_search_bare",
    label: "只有链接",
    kind: "model",
    ops: [
      {
        op: "update",
        id: sight.id,
        fields: { source: { kind: "检索", url: "https://example.com/xian", note: "只有链接" } },
      },
    ],
  });
  if (!bareSearch.ok) return bareSearch.error;
  const bare = bareSearch.book.items.find((item) => item.id === sight.id);
  if (bare?.source.kind !== "推断" || bare.source.note !== "只有链接") {
    return `没有取数时间的检索应改成推断，得到 ${bare?.source.kind} ${bare?.source.note ?? ""}`;
  }

  const added = applyPatch(book, {
    id: "p_add_lie",
    label: "加上假实测",
    kind: "model",
    ops: [
      {
        op: "add",
        item: {
          ...sight,
          id: "i_claim",
          title: "书院门",
          locked: true,
          source: { kind: "实测", note: "你改的时间" },
          note: "你改的时间。下午去。",
        },
      },
    ],
  });
  if (!added.ok) return added.error;
  const created = added.book.items.find((item) => item.id === "i_claim");
  if (!created || created.locked || created.source.kind !== "推断" || created.note !== "下午去。") {
    return `新增项也不能写成你改的时间，得到 locked=${created?.locked} ${created ? spokenClaim(created) : "无"}`;
  }
  if (spokenClaim(created).includes("你改的时间") || spokenClaim(created).includes("来自你的原话")) {
    return `新增项仍带着原话标签：${spokenClaim(created)}`;
  }

  const userClock = applyPatch(book, {
    id: "p_user_claim",
    label: "用户改的",
    kind: "user",
    ops: [
      {
        op: "update",
        id: sight.id,
        fields: { source: { kind: "实测", note: "你改的时间" }, note: "来自你的原话" },
      },
    ],
  });
  if (!userClock.ok) return userClock.error;
  const kept = userClock.book.items.find((item) => item.id === sight.id);
  if (kept?.source.kind !== "实测" || kept.source.note !== "你改的时间" || kept.note !== "来自你的原话") {
    return `用户自己的修改仍应保留实测和原话，得到 ${kept ? spokenClaim(kept) : "无"}`;
  }

  const onlyLock = opsFromUnknown({ ops: [{ op: "update", id: sight.id, locked: true }] });
  const wrappedLock = opsFromUnknown({ ops: [{ op: "update", id: sight.id, fields: { locked: true } }] });
  if ("error" in onlyLock || onlyLock.ops.length !== 0 || "error" in wrappedLock || wrappedLock.ops.length !== 0) {
    return "只写 locked 的模型 update 应被丢掉";
  }
  const noop = applyPatch(book, { id: "p_lock_only", label: "只锁", kind: "model", ops: onlyLock.ops });
  if (!noop.ok) return noop.error;
  const directEmpty = applyPatch(book, {
    id: "p_empty_fields",
    label: "空字段",
    kind: "model",
    ops: [{ op: "update", id: sight.id, fields: {} }],
  });
  if (!directEmpty.ok) return directEmpty.error;
  if (
    noop.book.undo.length !== undoBefore ||
    noop.book.patchHistory.length !== historyBefore ||
    directEmpty.book.undo.length !== undoBefore ||
    directEmpty.book.patchHistory.length !== historyBefore
  ) {
    return "空的模型补丁不应占用撤销";
  }
  if (noop.book.items.find((item) => item.id === sight.id)?.locked) return "只写 locked 不应把项锁上";

  const mixed = opsFromUnknown({
    ops: [
      { op: "update", id: sight.id, locked: true },
      { op: "update", id: other.id, title: "书院门", note: "来自你的原话" },
    ],
  });
  if ("error" in mixed || mixed.ops.length !== 1 || mixed.ops[0]?.op !== "update" || mixed.ops[0].id !== other.id) {
    return "混合补丁应只留下有内容的那条";
  }
  const mixedApplied = applyPatch(book, { id: "p_mixed_lock", label: "混合", kind: "model", ops: mixed.ops });
  if (!mixedApplied.ok) return mixedApplied.error;
  const mixedSight = mixedApplied.book.items.find((item) => item.id === sight.id);
  const mixedOther = mixedApplied.book.items.find((item) => item.id === other.id);
  if (mixedSight?.title !== sight.title || mixedSight.locked) return "混合补丁不应改只写了 locked 的项";
  if (mixedOther?.title !== "书院门" || (mixedOther.note ?? "").includes("来自你的原话")) {
    return `混合补丁应改另一项并去掉原话，得到 ${mixedOther?.title} ${mixedOther?.note ?? ""}`;
  }
  if (mixedApplied.book.undo.length !== undoBefore + 1) return "混合补丁应只占用一步撤销";
  return null;
}

function assertStyleNotesAndLocks(): string | null {
  const now = new Date("2026-11-01T02:00:00.000Z");
  let n = 0;
  const random = () => `sn${(n += 1)}`;
  const book = buildDraft("杭州玩2天", { id: "style-note", now, random });
  const lake = book.items.find((item) => item.title === "西湖");
  const temple = book.items.find((item) => item.title === "灵隐寺");
  const street = book.items.find((item) => item.title === "河坊街");
  if (!lake || !temple || !street) return "杭州两天应有西湖、灵隐寺和河坊街";
  const handwritten = "手写的西湖备注";
  const prepared: Roadbook = {
    ...book,
    items: book.items.map((item) => (item.id === lake.id ? { ...item, note: handwritten } : item)),
  };
  const rainy = applyRoadbookStyle(prepared, "雨天版", false, now);
  if (!rainy.ok) return rainy.confirm ? rainy.note : rainy.error;
  const museum = rainy.book.items.find((item) => item.id === lake.id);
  const rainyNote = "雨天版。原来是「西湖」。室内。西湖下雨或想歇脚时优先来这里。闭馆日请核实。";
  if (museum?.title !== "浙江省博物馆" || museum.note !== rainyNote || museum.note.includes(handwritten) || museum.note.includes("沿白堤")) {
    return `西湖换成博物馆后应只留雨天句子，得到 ${museum?.title ?? "无"} ${museum?.note ?? ""}`;
  }
  const templeAfter = rainy.book.items.find((item) => item.id === temple.id);
  if (!templeAfter || templeAfter.title === temple.title || templeAfter.note?.includes("门票") || !templeAfter.note?.startsWith("雨天版。原来是「灵隐寺」")) {
    return `灵隐寺换标题后不应留下旧备注，得到 ${templeAfter?.title ?? "无"} ${templeAfter?.note ?? ""}`;
  }
  const streetAfter = rainy.book.items.find((item) => item.id === street.id);
  if (streetAfter?.title !== street.title || !streetAfter.note?.includes("看一条街就离开") || !streetAfter.note.includes("雨天版。河坊街仍留在户外")) {
    return `标题不变的河坊街应在原备注后接雨天句子，得到 ${streetAfter?.title ?? "无"} ${streetAfter?.note ?? ""}`;
  }
  const must: Roadbook = {
    ...book,
    items: book.items.map((item) => (item.id === lake.id ? { ...item, priority: "必去" } : item)),
  };
  const rainyMust = applyRoadbookStyle(must, "雨天版", false, now);
  if (!rainyMust.ok) return rainyMust.confirm ? rainyMust.note : rainyMust.error;
  const keptLake = rainyMust.book.items.find((item) => item.id === lake.id);
  if (keptLake?.title !== "西湖" || !keptLake.note?.includes("沿白堤") || !keptLake.note.includes("雨天版。西湖仍留在户外")) {
    return `必去的西湖应留在原地并接上雨天句子，得到 ${keptLake?.title ?? "无"} ${keptLake?.note ?? ""}`;
  }

  const cheap = applyRoadbookStyle(book, "更省钱", false, now);
  if (!cheap.ok) return cheap.confirm ? cheap.note : cheap.error;
  const cheapTemple = cheap.book.items.find((item) => item.id === temple.id);
  const cheapNote = "更省钱。原来是「灵隐寺」。改去不收门票的地方，这段也可以改坐公交，不打车。";
  if (cheapTemple?.title === "灵隐寺" || cheapTemple?.note !== cheapNote || cheapTemple.note.includes("出发前核实")) {
    return `更省钱换成别的景点后应只留省钱句子，得到 ${cheapTemple?.title ?? "无"} ${cheapTemple?.note ?? ""}`;
  }

  const lock = planLockMust(rainy.book, museum.id);
  if (!lock.request) return lock.note;
  const locked = applyPatch(rainy.book, { ...lock.request, id: "p_lock_museum" });
  if (!locked.ok) return locked.error;
  const ask = applyRoadbookStyle(locked.book, "更省钱", false, now);
  if (ask.ok || !ask.confirm) return "锁定后再换风格应先确认";
  const again = applyRoadbookStyle(locked.book, "更省钱", true, now);
  if (!again.ok) return again.confirm ? again.note : again.error;
  const museumCount = again.book.items.filter((item) => item.title === "浙江省博物馆").length;
  if (museumCount !== 1) return `锁定的浙江省博物馆不应再被排进去，出现了 ${museumCount} 次`;
  const still = again.book.items.find((item) => item.id === museum.id);
  if (!still?.locked || still.title !== "浙江省博物馆" || !still.note?.startsWith("雨天版")) {
    return `锁定的博物馆应保持雨天版，得到 ${still?.title ?? "无"} locked=${still?.locked} ${still?.note ?? ""}`;
  }
  const sightTitles = again.book.items.filter((item) => item.type === "景点").map((item) => item.title);
  const duplicated = sightTitles.filter((title, index) => sightTitles.indexOf(title) !== index);
  if (duplicated.length > 0) return `换到更省钱后景点重复了：${duplicated.join("、")}`;
  return null;
}

function assertMealToday(): string | null {
  const builtNow = new Date("2026-11-01T02:00:00.000Z");
  let n = 0;
  const random = () => `md${(n += 1)}`;
  const built = buildDraft("从上海去北京玩2天", { id: "meal-day", now: builtNow, random });
  const day1 = lunchOn(built, 1);
  const day2 = lunchOn(built, 2);
  if (!day1 || !day2 || day1.id === day2.id) return "北京两天应有两顿午饭";
  const before = planMessage(built, "把午饭改到 13:00", random, builtNow);
  if (!before.request) return before.note || "出发前应能改午饭";
  const beforeId = before.request.ops.find((op) => op.op === "update" && op.fields.startTime === "13:00");
  if (!beforeId || beforeId.op !== "update" || beforeId.id !== day1.id) return "出发前「把午饭改到 13:00」应改第 1 天";
  const beforeApplied = applyPatch(built, { ...before.request, id: "p_lunch_before" });
  if (!beforeApplied.ok) return beforeApplied.error;
  if (beforeApplied.book.items.find((item) => item.id === day2.id)?.startTime !== day2.startTime) {
    return "出发前不应改到第 2 天的午饭";
  }

  const during = new Date("2026-11-08T04:00:00.000Z");
  const onTrip: Roadbook = { ...built, startDate: "2026-11-07" };
  const spoken = planMessage(onTrip, "把午饭改到 13:00", random, during);
  if (!spoken.request) return spoken.note || "行程中应能改今天的午饭";
  const spokenId = spoken.request.ops.find((op) => op.op === "update" && op.fields.startTime === "13:00");
  if (!spokenId || spokenId.op !== "update" || spokenId.id !== day2.id) return "今天是第 2 天时，应改第 2 天的午饭";
  const menuToday = planItemMove(onTrip, day2.id, "13:00");
  if (!sameClockOps(spoken.request, menuToday.request)) return "今天这一餐的句子应走挪时间的同一套改动";
  const applied = applyPatch(onTrip, { ...spoken.request, id: "p_lunch_today" });
  if (!applied.ok) return applied.error;
  const day1After = applied.book.items.find((item) => item.id === day1.id);
  const day2After = applied.book.items.find((item) => item.id === day2.id);
  if (day1After?.startTime !== day1.startTime) return `第 1 天午饭应停在 ${day1.startTime}，得到 ${day1After?.startTime ?? "无"}`;
  if (day2After?.startTime === day2.startTime) return "第 2 天午饭应被改到 13:00";

  const hidden: Roadbook = {
    ...built,
    items: built.items.map((item) => (item.id === day1.id ? { ...item, startTime: "08:00" } : item)),
  };
  const later = planMessage(hidden, "把午饭改到 13:00", random, new Date("2026-11-02T04:00:00.000Z"));
  if (!later.request) return later.note || "今天没有午饭时应改后面的午饭";
  const laterId = later.request.ops.find((op) => op.op === "update" && op.fields.startTime === "13:00");
  if (!laterId || laterId.op !== "update" || laterId.id !== day2.id) return "今天这一餐不在时，应改后面一天的午饭";
  const menuHidden = planItemMove(hidden, day1.id, "13:00");
  if (!menuHidden.request) return menuHidden.note || "点某一项挪时间应仍改那一项";
  const menuHiddenId = menuHidden.request.ops.find((op) => op.op === "update" && op.id === day1.id);
  if (!menuHiddenId) return "挪时间应改点中的那一顿，而不是今天的午饭";

  const ended = planMessage(onTrip, "把午饭改到 13:00", random, new Date("2026-11-12T04:00:00.000Z"));
  if (ended.request || ended.note !== "行程已经结束，没有改午饭。") {
    return `行程结束后不应改第 1 天午饭，得到 ${ended.note || "改了"}`;
  }
  const menuEnded = planItemMove(onTrip, day1.id, "13:00");
  if (!menuEnded.request) return menuEnded.note || "行程结束后，点某一项仍应能挪时间";
  const menuEndedId = menuEnded.request.ops.find((op) => op.op === "update" && op.fields.startTime === "13:00");
  if (!menuEndedId || menuEndedId.op !== "update" || menuEndedId.id !== day1.id) return "结束后的挪时间应仍改点中的那一项";

  const day1Breakfast = breakfastOn(built, 1);
  const day2Breakfast = breakfastOn(built, 2);
  if (day1Breakfast) return "北京两天的第 1 天早上应是去程，没有早饭";
  if (!day2Breakfast) return "北京两天的第 2 天应有早饭";
  const breakfast = planMessage(built, "把早饭改到 8:00", random, builtNow);
  if (!breakfast.request) return breakfast.note || "出发前应能改到最早有早饭的那一天";
  const breakfastId = breakfast.request.ops.find((op) => op.op === "update" && op.fields.startTime === "08:00");
  if (!breakfastId || breakfastId.op !== "update" || breakfastId.id !== day2Breakfast.id) {
    return "出发前「把早饭改到 8:00」应改第 2 天的早饭";
  }
  const breakfastApplied = applyPatch(built, { ...breakfast.request, id: "p_breakfast_before" });
  if (!breakfastApplied.ok) return breakfastApplied.error;
  const movedBreakfast = breakfastApplied.book.items.find((item) => item.id === day2Breakfast.id);
  if (movedBreakfast?.startTime !== "08:00" || movedBreakfast.source.kind !== "实测" || movedBreakfast.source.note !== "你改的时间") {
    return `第 2 天早饭应改到 08:00 并标成你改的时间，得到 ${movedBreakfast?.startTime} ${movedBreakfast?.source.kind} ${movedBreakfast?.source.note}`;
  }
  const noBreakfast: Roadbook = {
    ...built,
    items: built.items.filter((item) => item.id !== day2Breakfast.id),
  };
  const missingBreakfast = planMessage(noBreakfast, "把早饭改到 8:00", random, builtNow);
  if (missingBreakfast.request || missingBreakfast.note !== "没有找到要改时间的项。") {
    return `没有早饭时应说明没找到，得到 ${missingBreakfast.note || "改了"}`;
  }
  const endedBreakfast = planMessage(onTrip, "把早饭改到 8:00", random, new Date("2026-11-12T04:00:00.000Z"));
  if (endedBreakfast.request || endedBreakfast.note !== "行程已经结束，没有改早饭。") {
    return `行程结束后不应改早饭，得到 ${endedBreakfast.note || "改了"}`;
  }
  const menuBreakfast = planItemMove(onTrip, day2Breakfast.id, "08:00");
  if (!menuBreakfast.request) return menuBreakfast.note || "行程结束后，点早饭仍应能挪时间";
  const menuBreakfastId = menuBreakfast.request.ops.find((op) => op.op === "update" && op.fields.startTime === "08:00");
  if (!menuBreakfastId || menuBreakfastId.op !== "update" || menuBreakfastId.id !== day2Breakfast.id) {
    return "结束后点早饭挪时间应仍改点中的那一顿";
  }
  return null;
}

function itemChanged(before: Roadbook, after: Roadbook): boolean {
  if (before.items.length !== after.items.length) return true;
  return after.items.some((item) => {
    const prev = before.items.find((entry) => entry.id === item.id);
    return (
      !prev ||
      prev.title !== item.title ||
      prev.place !== item.place ||
      (prev.note ?? "") !== (item.note ?? "") ||
      prev.startTime !== item.startTime
    );
  });
}

type XianLiveBooks = {
  swap: Roadbook;
  swapText: string;
  refine: Roadbook;
};

/**
 * Real 西安 7 天 draft. A free template fails here instead of being filled with a 兵马俑 clone.
 * 模型修补 only renames 兵马俑 on that same draft.
 */
function xianLiveBooks(): XianLiveBooks | string {
  const now = new Date("2026-11-01T02:00:00.000Z");
  let n = 0;
  const random = () => `lv${(n += 1)}`;
  const draft = buildDraft("从上海去西安玩7天", { id: "live-xian", now, random });
  const host =
    draft.items.find((item) => item.type === "景点" && item.title.includes("兵马俑")) ??
    draft.items.find((item) => item.type === "景点");
  if (!host) return "在线模型补丁缺少景点";
  const choice = chooseItemSwap(draft, host.id, true);
  if (choice.mode !== "model") {
    return `西安 7 天的换一个应走模型（模板已经排完），得到 ${choice.mode}：${choice.note}`;
  }
  return {
    swap: draft,
    swapText: choice.text,
    refine: {
      ...draft,
      items: draft.items.map((item) => (item.id === host.id ? { ...item, title: "城墙", note: undefined } : item)),
    },
  };
}

function assertXianSwapExhausted(): string | null {
  const books = xianLiveBooks();
  return typeof books === "string" ? books : null;
}

function assertPosterWrap(): string | null {
  const width = (value: string) => Array.from(value).length;
  if (!isWrapPunctuation("。") || !isWrapPunctuation("，") || !isWrapPunctuation(")") || isWrapPunctuation("甲")) {
    return "换行标点应认出句号、逗号和右括号";
  }
  const joined = wrapMeasuredText("甲乙。", 10, width);
  if (joined.length !== 1 || joined[0] !== "甲乙。") return `放得下的句子不应换行：${joined.join("|")}`;
  const pulled = wrapMeasuredText("甲乙。", 2, width);
  if (pulled.join("|") !== "甲|乙。") return `句号不应另起一行：${pulled.join("|")}`;
  const comma = wrapMeasuredText("去吃饭，然后", 3, width);
  if (comma.join("|") !== "去吃|饭，然|后") return `逗号应跟在上一字后面：${comma.join("|")}`;
  const ascii = wrapMeasuredText("Hello).", 5, width);
  if (ascii.join("|") !== "Hell|o).") return `右括号不应另起一行：${ascii.join("|")}`;
  const stuck = wrapMeasuredText("甲。", 1, width);
  if (stuck.join("|") !== "甲|。") return `上一行只剩一个字时可以让标点另起一行：${stuck.join("|")}`;
  const paragraph = wrapMeasuredText("上午去城墙，下午看博物馆。", 6, width);
  const opened = paragraph.slice(1).find((line) => isWrapPunctuation(Array.from(line)[0] ?? ""));
  if (opened) return `换行不应以标点开头：${paragraph.join("|")}`;
  return null;
}

/** Real model: 换一个 (no template left) and 模型修补 must each change an item. Skips when no key is configured. */
async function assertLiveModelPatch(): Promise<string | null> {
  if (!hasLlmKey()) return null;
  const env = readLlmEnv();
  const books = xianLiveBooks();
  if (typeof books === "string") return books;
  const cases: { label: string; book: Roadbook; text: string | null }[] = [
    { label: "换一个", book: books.swap, text: books.swapText },
    { label: "模型修补", book: books.refine, text: null },
  ];
  const problems = await mapFixtures(cases, LIVE_CONCURRENCY, async (item) => {
    try {
      const plan = await proposeModelPatch(item.book, item.text, env);
      if (!plan.request) return `${item.label}没有改这一项：${plan.note}`;
      const applied = applyPatch(item.book, { ...plan.request, id: `p_live_${item.label === "换一个" ? "swap" : "refine"}` });
      if (!applied.ok) return `${item.label}补丁没有写上：${applied.error}`;
      if (!itemChanged(item.book, applied.book)) return `${item.label}的补丁没有改到任何一项`;
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "模型没有完成";
      return `${item.label}调用失败：${message.slice(0, 180)}`;
    }
  });
  const failed = problems.filter((item): item is string => Boolean(item));
  return failed.length > 0 ? failed.join("\n") : null;
}

function assertShareKeyWrites(): Promise<string | null> {
  const repo = path.resolve(root, "..");
  return new Promise((resolve) => {
    const child = spawn(
      "pnpm",
      ["exec", "tsx", "--tsconfig", "apps/web/tsconfig.json", "apps/web/scripts/share-key-writes.ts"],
      { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += String(chunk);
    });
    child.on("error", (error) => resolve(error.message));
    child.on("close", (code) => {
      if (code === 0) resolve(null);
      else resolve((err || out || `share-key eval exited ${code}`).trim());
    });
  });
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
  const undoError = assertMultiStepUndo();
  if (undoError) {
    console.error(`undo  ${undoError}`);
    process.exit(1);
  }
  console.log("  ok multi-step undo");
  const credibilityError = assertCredibility();
  if (credibilityError) {
    console.error(`credibility  ${credibilityError}`);
    process.exit(1);
  }
  console.log("  ok source honesty, checklist, ownerId");
  const menuError = assertItemMenu();
  if (menuError) {
    console.error(`menu  ${menuError}`);
    process.exit(1);
  }
  console.log("  ok item menu, lock, return delete");
  const shareError = assertShare();
  if (shareError) {
    console.error(`share  ${shareError}`);
    process.exit(1);
  }
  console.log("  ok share payload and share-key refusal");
  const styleError = assertStyles();
  if (styleError) {
    console.error(`style  ${styleError}`);
    process.exit(1);
  }
  console.log("  ok style switch, main plan, confirm, share snapshot");
  const waveError = assertWaveFixes();
  if (waveError) {
    console.error(`wave  ${waveError}`);
    process.exit(1);
  }
  console.log("  ok lock undo, style locks, notes, swap, meals, share wording");
  const patchShapeError = assertModelPatchParse();
  if (patchShapeError) {
    console.error(`model-patch  ${patchShapeError}`);
    process.exit(1);
  }
  console.log("  ok flat and wrapped model patches, claim refusal, empty lock");
  const styleNoteError = assertStyleNotesAndLocks();
  if (styleNoteError) {
    console.error(`style-note  ${styleNoteError}`);
    process.exit(1);
  }
  console.log("  ok style notes and locked sight titles");
  const mealTodayError = assertMealToday();
  if (mealTodayError) {
    console.error(`meal-today  ${mealTodayError}`);
    process.exit(1);
  }
  console.log("  ok lunch follows today; breakfast before departure uses the first day that has it");
  const xianSwapError = assertXianSwapExhausted();
  if (xianSwapError) {
    console.error(`xian-swap  ${xianSwapError}`);
    process.exit(1);
  }
  console.log("  ok xi'an 7-day swap has no template left");
  const wrapError = assertPosterWrap();
  if (wrapError) {
    console.error(`poster-wrap  ${wrapError}`);
    process.exit(1);
  }
  console.log("  ok poster wrap keeps punctuation off the next line");
  const shareKeyError = await assertShareKeyWrites();
  if (shareKeyError) {
    console.error(`share-key  ${shareKeyError}`);
    process.exit(1);
  }
  console.log("  ok shareKey stable after writes");
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
  const round2Error = assertQaRound2();
  if (round2Error) {
    console.error(`round2  ${round2Error}`);
    process.exit(1);
  }
  console.log("  ok round2 phrases, dates, jinan edits");
  const round3Error = assertRound3();
  if (round3Error) {
    console.error(`round3  ${round3Error}`);
    process.exit(1);
  }
  console.log("  ok return honesty, retime, range, departure clock");
  const spanError = assertSpanBriefs();
  if (spanError) {
    console.error(`span  ${spanError}`);
    process.exit(1);
  }
  console.log("  ok day span, same-day guess, five-day extract");
  const fixError = assertConfirmedFixes();
  if (fixError) {
    console.error(`fixes  ${fixError}`);
    process.exit(1);
  }
  console.log("  ok shared rides, first-day arrival, filler titles");
  const userFixError = assertUserFixes();
  if (userFixError) {
    console.error(`user-fixes  ${userFixError}`);
    process.exit(1);
  }
  console.log("  ok return clock, day count, outbound, taishan breakfast");
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
  const outcomes = await mapFixtures(fixtures, live ? LIVE_CONCURRENCY : 1, (fixture) => runFixture(fixture, live));
  let failed = 0;
  let sawPlan = false;
  for (const outcome of outcomes) {
    if (outcome.failed) failed += 1;
    if (outcome.planned) sawPlan = true;
    console.log(outcome.line);
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
  let liveFailed = false;
  if (live) {
    const liveExtractError = await assertLiveExtract();
    if (liveExtractError) {
      liveFailed = true;
      console.error(`extract-live  ${liveExtractError}`);
    } else {
      console.log("  ok live extract sentences");
    }
    const livePatchError = await assertLiveModelPatch();
    if (livePatchError) {
      liveFailed = true;
      console.error(`model-patch-live  ${livePatchError}`);
    } else if (hasLlmKey()) {
      console.log("  ok live model swap and refine");
    } else {
      console.log("  skip live model swap and refine (no key)");
    }
  }
  console.log(`${fixtures.length - failed}/${fixtures.length} passed`);
  process.exit(failed === 0 && !liveFailed ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
