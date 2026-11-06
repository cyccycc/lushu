import type { PlanVariant } from "./types";
import { formatDayWeather } from "./weather-view";

export function itineraryToMarkdown(
  variant: PlanVariant,
  meta: { brief?: string; modeNote?: string } = {},
): string {
  const lines: string[] = [
    "> 此行程由 AI 生成，仅供参考。路书不提供预订，也不向使用者收款。",
    "",
    `# ${variant.title}`,
    "",
    variant.summary,
    "",
    `节奏：${variant.pace}`,
    "",
    `适合：${variant.suitability}`,
    "",
  ];
  if (meta.brief) {
    lines.push("## 原来的需求", "", meta.brief, "");
  }
  if (meta.modeNote) {
    lines.push(`> ${meta.modeNote}`, "");
  }
  lines.push("## 预算说明", "", variant.budgetNote, "");
  for (const day of variant.days) {
    lines.push(
      `## 第 ${day.day} 天 · ${day.title}`,
      "",
      formatDayWeather(day.weather, day.city),
      "",
      `${day.city} · ${day.theme}`,
      "",
    );
    for (const item of day.items) {
      const area = item.area ? `（${item.area}）` : "";
      const cost = item.estCost ? ` ${item.estCost}。` : "";
      lines.push(`- **${item.time}** ${item.title}${area}：${item.detail}${cost}`);
    }
    lines.push("", `雨天或走不动：${day.rainPlanB}`, "");
    if (day.meals.length > 0) lines.push(`吃：${day.meals.join(" / ")}`, "");
    lines.push(`住：${day.stayNote}`, "");
  }
  if (variant.supplements && variant.supplements.length > 0) {
    lines.push("## 补充", "");
    for (const extra of variant.supplements) {
      lines.push(`### ${extra.title}`, "", extra.body, "");
    }
  }
  lines.push("## 假设", "");
  for (const line of variant.assumptions) lines.push(`- ${line}`);
  lines.push("", "## 请注意", "");
  for (const line of variant.warnings) lines.push(`- ${line}`);
  lines.push("", "## 来源", "");
  for (const source of variant.sources) {
    const url = source.url ? ` ${source.url}` : "";
    const note = source.note ? ` — ${source.note}` : "";
    lines.push(`- ${source.title}${url}${note}`);
  }
  lines.push("");
  return lines.join("\n");
}
