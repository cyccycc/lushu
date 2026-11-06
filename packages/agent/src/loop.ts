import { chatComplete, hasLlmKey, LlmError } from "@lushu/llm";
import { getWeather, webSearch } from "@lushu/tools";
import { guideFor } from "./cities";
import {
  buildFallbackVariants,
  contrastFor,
  emptyBundle,
  planQueries,
  trimBundle,
} from "./fallback";
import { extractJson } from "./json";
import {
  addTokens,
  canCallModel,
  emptyUsage,
  noteLimit,
  overCost,
  readAgentLimits,
} from "./limits";
import { coercePlan } from "./normalize";
import { parseBrief } from "./parse";
import { planUserPrompt, synthUserPrompt, SYSTEM_PROMPT } from "./prompts";
import { attachWeather } from "./weather-view";
import type { AgentLimits, AgentResult, AgentStep, AgentUsage, ToolBundle, TripSpec } from "./types";

export class AgentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentInputError";
  }
}

export type RunOptions = {
  llm?: "auto" | "off";
  tools?: "auto" | "stub";
  limits?: Partial<AgentLimits>;
  onStep?: (snapshot: { steps: AgentStep[]; usage: AgentUsage }) => void;
  signal?: AbortSignal;
};

function emit(steps: AgentStep[], usage: AgentUsage, onStep: RunOptions["onStep"]): void {
  onStep?.({
    steps: steps.map((step) => ({ ...step })),
    usage: { ...usage },
  });
}

function openStep(
  steps: AgentStep[],
  phase: AgentStep["phase"],
  title: string,
  detail: string,
): AgentStep {
  const step: AgentStep = {
    id: `s${steps.length + 1}`,
    phase,
    title,
    detail,
    status: "running",
    startedAt: new Date().toISOString(),
  };
  steps.push(step);
  return step;
}

function closeStep(step: AgentStep, detail: string, status: AgentStep["status"] = "done"): void {
  step.detail = detail;
  step.status = status;
  step.finishedAt = new Date().toISOString();
}

function beginModel(usage: AgentUsage): boolean {
  if (usage.limitReached || overCost(usage)) return false;
  if (usage.steps >= usage.maxSteps) {
    noteLimit(usage, `已达到步骤上限（${usage.maxSteps}），停止继续调用模型。`);
    return false;
  }
  usage.steps += 1;
  return true;
}

function beginTool(usage: AgentUsage): boolean {
  if (usage.limitReached || overCost(usage)) return false;
  if (usage.toolCalls >= usage.maxToolCalls || usage.steps + 1 >= usage.maxSteps) {
    noteLimit(
      usage,
      `已达到本会话上限（步骤 ${usage.maxSteps}，工具 ${usage.maxToolCalls}），后面的检索停掉了。`,
    );
    return false;
  }
  usage.steps += 1;
  usage.toolCalls += 1;
  return true;
}

function charge(usage: AgentUsage, result: { usage: { promptTokens: number; completionTokens: number }; estimatedUsd: number }): void {
  addTokens(usage, {
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    estimatedUsd: result.estimatedUsd,
  });
}

function mergeSpec(base: TripSpec, raw: unknown, queries: string[]): { spec: TripSpec; queries: string[] } {
  if (!raw || typeof raw !== "object") return { spec: base, queries };
  const draft = raw as Record<string, unknown>;
  const spec: TripSpec = { ...base, themes: [...base.themes], constraints: [...base.constraints] };
  if (base.destinations.includes("未写明的目的地") && Array.isArray(draft.destinations)) {
    const found = draft.destinations
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item && base.rawBrief.includes(item));
    if (found.length > 0) spec.destinations = found.slice(0, 6);
  }
  if (
    base.daysAssumed &&
    typeof draft.days === "number" &&
    draft.days >= 1 &&
    draft.days <= 14
  ) {
    spec.days = Math.round(draft.days);
    spec.daysAssumed = false;
  }
  const modelQueries = Array.isArray(draft.queries)
    ? draft.queries
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 1 && item.length < 80 && !/^https?:/i.test(item))
        .slice(0, 3)
    : [];
  return { spec, queries: modelQueries.length > 0 ? modelQueries : queries };
}

async function collectTools(
  spec: TripSpec,
  queries: string[],
  usage: AgentUsage,
  steps: AgentStep[],
  options: RunOptions,
): Promise<ToolBundle> {
  const bundle = emptyBundle();
  const mode = options.tools === "stub" ? "stub" : "auto";
  for (const query of queries.slice(0, 3)) {
    if (!beginTool(usage)) break;
    const step = openStep(steps, "searching", `检索：${query}`, "正在查公开信息。");
    emit(steps, usage, options.onStep);
    try {
      const result = await webSearch(query, { mode });
      bundle.searches.push(result);
      const count = result.results.length;
      closeStep(
        step,
        result.stub
          ? result.note ?? "这一步没有实时检索。"
          : `拿到 ${count} 条公开结果。`,
      );
    } catch {
      closeStep(step, "检索没有完成。", "error");
    }
    emit(steps, usage, options.onStep);
  }

  for (const city of spec.destinations.slice(0, 2)) {
    if (city === "未写明的目的地") continue;
    if (!beginTool(usage)) break;
    const step = openStep(steps, "searching", `天气：${city}`, "正在查未来几天的预报。");
    emit(steps, usage, options.onStep);
    try {
      const report = await getWeather(city, Math.min(spec.days, 7), {
        mode,
        alternateName: guideFor(city).english,
      });
      bundle.weather.push(report);
      closeStep(
        step,
        report.stub
          ? report.note ?? "没有拿到预报。"
          : `${report.resolvedName ?? city}：${report.days[0] ? report.days[0].summary : "已返回预报"}。`,
      );
    } catch {
      closeStep(step, "天气没有查到。", "error");
    }
    emit(steps, usage, options.onStep);
  }
  return bundle;
}

export async function runTravelAgent(brief: string, options: RunOptions = {}): Promise<AgentResult> {
  const text = brief.trim();
  if (!text) throw new AgentInputError("先写一段行程：去哪儿、几天、和谁、预算。");
  if (text.length > 2000) throw new AgentInputError("需求请写在 2000 字以内。");

  const limits = { ...readAgentLimits(), ...options.limits };
  const usage = emptyUsage(limits);
  const steps: AgentStep[] = [];
  let spec = parseBrief(text);
  let queries = planQueries(spec);
  const allowLlm = options.llm !== "off" && hasLlmKey();
  let mode: AgentResult["mode"] = "fallback";
  let modeNote =
    options.llm === "off"
      ? "这次按离线规划运行，没有调用模型。"
      : "未配置 LLM_API_KEY，这是本地规划草案。配上密钥后，行程正文会改由模型撰写。";

  const planning = openStep(steps, "planning", "理解这段需求", "先看目的地、天数、预算和限制。");
  emit(steps, usage, options.onStep);

  if (allowLlm && canCallModel(usage)) {
    if (beginModel(usage)) {
      try {
        const planned = await chatComplete({
          json: true,
          temperature: 0.2,
          signal: options.signal,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: planUserPrompt(text, spec) },
          ],
        });
        charge(usage, planned);
        const merged = mergeSpec(spec, extractJson(planned.content), queries);
        spec = merged.spec;
        queries = merged.queries;
        closeStep(planning, `${spec.destinations.join("、")}，${spec.days} 天。`);
      } catch (error) {
        const reason = error instanceof LlmError ? error.message : "模型没有完成这一步。";
        closeStep(planning, `已改用本地理解：${spec.destinations.join("、")}，${spec.days} 天。${reason}`, "error");
        modeNote = "模型这一步没有完成，行程会由本地规划器来写。";
      }
    } else {
      closeStep(planning, `${spec.destinations.join("、")}，${spec.days} 天。已触及步骤或费用上限。`, "skipped");
    }
  } else {
    closeStep(planning, `${spec.destinations.join("、")}，${spec.days} 天。${spec.party.summary}。`);
  }
  emit(steps, usage, options.onStep);

  const bundle = await collectTools(spec, queries, usage, steps, options);

  const writing = openStep(steps, "synthesizing", "整理两套方案", "把检索和天气收成可以比较的行程。");
  emit(steps, usage, options.onStep);

  let variants = null as AgentResult["variants"] | null;
  let contrast = "";
  if (allowLlm && canCallModel(usage) && beginModel(usage)) {
    try {
      const first = await chatComplete({
        json: true,
        temperature: 0.5,
        signal: options.signal,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: synthUserPrompt({ spec, tools: trimBundle(bundle) }) },
        ],
      });
      charge(usage, first);
      let coerced = coercePlan(extractJson(first.content), spec, bundle);
      if (!coerced && canCallModel(usage) && beginModel(usage)) {
        const repair = await chatComplete({
          json: true,
          temperature: 0.2,
          signal: options.signal,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: synthUserPrompt({ spec, tools: trimBundle(bundle) }) },
            { role: "assistant", content: first.content.slice(0, 6000) },
            {
              role: "user",
              content:
                "上一次的 JSON 不可用。请只重新输出一个 JSON：恰好 2 套 variants，每天都有 items 和 rainPlanB，并写清 budgetNote 与 sources。不要编造工具里没有的 URL。",
            },
          ],
        });
        charge(usage, repair);
        coerced = coercePlan(extractJson(repair.content), spec, bundle);
      }
      if (coerced) {
        variants = coerced.variants;
        contrast = coerced.contrast;
        mode = "llm";
        modeNote = `由 ${process.env.LLM_MODEL || "grok-4.7"} 撰写，并参考了本轮工具结果。`;
        closeStep(writing, "两套方案已经写好。");
      } else {
        closeStep(writing, "模型没有返回可用的行程结构，已改用本地规划器。", "error");
        modeNote = "模型没有返回可用行程，已改用本地规划器整理。";
      }
    } catch (error) {
      const reason = error instanceof LlmError ? error.message : "模型请求失败。";
      closeStep(writing, `已改用本地规划器。${reason}`, "error");
      modeNote = "模型请求失败，已改用本地规划器整理。";
    }
  } else if (allowLlm) {
    closeStep(writing, "费用或步骤到顶了，这一步改用本地规划器。", "skipped");
    modeNote = usage.limitReached ?? "已触及会话上限，行程由本地规划器整理。";
  } else {
    closeStep(writing, "本地规划器写好了两套方案。");
  }
  emit(steps, usage, options.onStep);

  const finalVariants = attachWeather(variants ?? buildFallbackVariants(spec, bundle, mode), bundle.weather);
  const finalContrast = contrast || contrastFor(finalVariants);
  const confirm = openStep(steps, "awaiting_confirm", "等你选一套", "选中之后生成可以分享的行程页。");
  closeStep(confirm, "两套方案可以比较了。");
  emit(steps, usage, options.onStep);

  return {
    spec,
    variants: finalVariants,
    contrast: finalContrast,
    steps,
    usage,
    mode,
    modeNote,
    aiGenerated: true,
  };
}
