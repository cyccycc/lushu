import type { WeatherReport } from "@lushu/tools";
import type { DayWeather, ItineraryDay, PlanVariant } from "./types";

function unavailable(city: string, note: string): DayWeather {
  return {
    city,
    date: null,
    condition: "暂不可用",
    tempMinC: null,
    tempMaxC: null,
    precipProbability: null,
    available: false,
    note,
  };
}

export function weatherForDay(city: string, dayIndex: number, reports: WeatherReport[]): DayWeather {
  const report =
    reports.find((item) => item.query === city || Boolean(item.resolvedName?.includes(city))) ??
    reports.find((item) => city.includes(item.query));
  if (!report) return unavailable(city, "没有查到这座城市的预报。");
  if (report.stub || report.days.length === 0) {
    return unavailable(city, report.note || "天气接口没有返回预报。");
  }
  const day = report.days[dayIndex];
  if (!day) return unavailable(city, "预报天数盖不住这一天，出发前请再查。");
  return {
    city,
    date: day.date,
    condition: day.summary,
    tempMinC: day.tempMinC,
    tempMaxC: day.tempMaxC,
    precipProbability: day.precipProbability,
    available: true,
    note: "",
  };
}

export function attachWeather(variants: PlanVariant[], reports: WeatherReport[]): PlanVariant[] {
  return variants.map((variant) => ({
    ...variant,
    days: variant.days.map((day) => ({
      ...day,
      weather: weatherForDay(day.city, Math.max(0, day.day - 1), reports),
    })),
  }));
}

export function formatDayWeather(weather: DayWeather | undefined, city: string): string {
  if (!weather?.available) {
    return `${weather?.city || city} · 预报暂不可用 · ${weather?.note || "没有拿到预报。"}`;
  }
  const temp =
    weather.tempMinC != null && weather.tempMaxC != null
      ? `${weather.tempMinC}–${weather.tempMaxC}°C`
      : "气温未知";
  const precip = weather.precipProbability != null ? `降水 ${weather.precipProbability}%` : "降水未知";
  return `${weather.city} · ${weather.date ?? "日期未知"} · ${weather.condition} · ${temp} · ${precip}`;
}

export function weatherHeaderText(days: ItineraryDay[]): string {
  const rows = days.map((day) => day.weather).filter((item): item is DayWeather => item != null);
  if (rows.length === 0 || rows.every((row) => !row.available)) {
    const note = rows.find((row) => row.note)?.note ?? "没有拿到预报。";
    return `预报暂不可用。${note}`;
  }
  const live = rows.filter((row) => row.available);
  const first = live[0];
  const last = live[live.length - 1];
  if (!first || !last) return "预报暂不可用。没有拿到预报。";
  const cities = [...new Set(live.map((row) => row.city))].join("、");
  const dates =
    first.date && last.date && first.date !== last.date ? `${first.date}–${last.date}` : (first.date ?? "日期未知");
  const conditions = [...new Set(live.map((row) => row.condition))].slice(0, 3).join(" / ");
  const lows = live.map((row) => row.tempMinC).filter((item): item is number => item != null);
  const highs = live.map((row) => row.tempMaxC).filter((item): item is number => item != null);
  const precips = live.map((row) => row.precipProbability).filter((item): item is number => item != null);
  const temp = lows.length > 0 && highs.length > 0 ? `${Math.min(...lows)}–${Math.max(...highs)}°C` : "气温未知";
  const precip =
    precips.length === 0
      ? "降水未知"
      : precips.length === 1
        ? `降水 ${precips[0]}%`
        : `降水 ${Math.min(...precips)}–${Math.max(...precips)}%`;
  return `${cities} · ${dates} · ${conditions} · ${temp} · ${precip}`;
}
