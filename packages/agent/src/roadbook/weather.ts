import type { WeatherReport } from "@lushu/tools";
import type { WeatherSnap } from "./types";

export function snapsFromReport(report: WeatherReport | null, city: string, fetchedAt: string): WeatherSnap[] {
  if (!report || report.stub || report.days.length === 0) {
    return [
      {
        city,
        query: report?.query || city,
        date: null,
        condition: "暂不可用",
        tempMinC: null,
        tempMaxC: null,
        precipProbability: null,
        available: false,
        note: report?.note || "预报暂不可用，出发前再查。",
        fetchedAt,
        sourceUrl: null,
      },
    ];
  }
  return report.days.map((day) => ({
    city,
    query: report.query,
    date: day.date,
    condition: day.summary,
    tempMinC: day.tempMinC,
    tempMaxC: day.tempMaxC,
    precipProbability: day.precipProbability,
    available: true,
    note: report.note ?? "",
    fetchedAt,
    sourceUrl: report.sourceUrl,
  }));
}
