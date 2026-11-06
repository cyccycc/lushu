import type { AgentLimits, AgentUsage } from "./types";

function num(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function readAgentLimits(env: NodeJS.ProcessEnv = process.env): AgentLimits {
  return {
    maxSteps: Math.min(32, Math.round(num(env.AGENT_MAX_STEPS, 8))),
    maxToolCalls: Math.min(32, Math.round(num(env.AGENT_MAX_TOOL_CALLS, 6))),
    maxCostUsd: num(env.AGENT_MAX_COST_USD, 0.5),
  };
}

export function emptyUsage(limits: AgentLimits): AgentUsage {
  return {
    steps: 0,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    estimatedUsd: 0,
    maxSteps: limits.maxSteps,
    maxToolCalls: limits.maxToolCalls,
    maxCostUsd: limits.maxCostUsd,
  };
}

export function overCost(usage: AgentUsage): boolean {
  return usage.estimatedUsd >= usage.maxCostUsd;
}

export function canCallModel(usage: AgentUsage): boolean {
  return usage.steps < usage.maxSteps && !overCost(usage) && !usage.limitReached;
}

export function canCallTool(usage: AgentUsage): boolean {
  return (
    usage.steps + 1 < usage.maxSteps &&
    usage.toolCalls < usage.maxToolCalls &&
    !overCost(usage) &&
    !usage.limitReached
  );
}

export function noteLimit(usage: AgentUsage, reason: string): void {
  if (!usage.limitReached) usage.limitReached = reason;
}

export function addTokens(
  usage: AgentUsage,
  tokens: { promptTokens: number; completionTokens: number; estimatedUsd: number },
): void {
  usage.promptTokens += tokens.promptTokens;
  usage.completionTokens += tokens.completionTokens;
  usage.estimatedUsd =
    Math.round((usage.estimatedUsd + tokens.estimatedUsd) * 1_000_000) / 1_000_000;
  if (overCost(usage)) {
    noteLimit(
      usage,
      `已达到本会话估算费用上限 $${usage.maxCostUsd.toFixed(2)}，停止继续调用模型。`,
    );
  }
}
