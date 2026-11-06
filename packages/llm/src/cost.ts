export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
};

export function estimateCostUsd(
  usage: TokenUsage,
  prices: { priceInputPerMtok: number; priceOutputPerMtok: number },
): number {
  const usd =
    (usage.promptTokens / 1_000_000) * prices.priceInputPerMtok +
    (usage.completionTokens / 1_000_000) * prices.priceOutputPerMtok;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
