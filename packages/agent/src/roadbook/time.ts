import type { Roadbook } from "./types";

export const DAY_END_MINUTES = 21 * 60 + 30;

export function parseTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function formatTime(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const NEXT_DAY_ARRIVAL = /预计次日\s*\d{1,2}:\d{2}\s*到。?/g;
const SAME_DAY_LIMIT = 23 * 60 + 30;

function tidyNote(text: string): string {
  return text
    .replace(/^[，。、\s]+/, "")
    .replace(/，{2,}/g, "，")
    .replace(/。{2,}/g, "。")
    .replace(/\s{2,}/g, " ")
    .replace(/。\s*。/g, "。")
    .trim();
}

/**
 * Drop time-of-day wording that disagrees with the clock actually on the calendar.
 * When `rideMinutes` is set, also rewrite 「预计次日 HH:MM 到」 from start + ride.
 * A trip that now finishes by 23:30 loses that sentence.
 */
export function noteForPlacedClock(
  note: string | undefined,
  startTime: string,
  rideMinutes?: number | null,
): string | undefined {
  if (!note && (rideMinutes == null || rideMinutes <= 0)) return note;
  const start = parseTime(startTime);
  let text = (note ?? "").replace(/先放在\s*\d{2}:\d{2}/g, `先放在 ${startTime}`);
  if (start != null) {
    const morning = start < 12 * 60;
    if (!morning) {
      text = text.replace(/单独一天的上午出发。?/g, "");
      text = text.replace(/早上|上午|凌晨|清晨/g, "");
    } else if (/晚上|傍晚/.test(text)) {
      text = text.replace(/晚上|傍晚/g, "");
    }
  }
  const rewriteArrival = rideMinutes != null && rideMinutes > 0;
  if (rewriteArrival) text = text.replace(NEXT_DAY_ARRIVAL, "");
  text = tidyNote(text);
  if (rewriteArrival && start != null && start + rideMinutes > SAME_DAY_LIMIT) {
    const arrival = formatTime((start + rideMinutes) % (24 * 60));
    const sentence = `预计次日 ${arrival} 到`;
    if (!text) return `${sentence}。`;
    const glue = text.endsWith("。") || text.endsWith("，") ? "" : "。";
    text = `${text}${glue}${sentence}。`;
  }
  return text;
}

export function endMinutes(startTime: string, durationMinutes: number): number | null {
  const start = parseTime(startTime);
  if (start == null) return null;
  return start + durationMinutes;
}

const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"];

export function shanghaiWeekday(now: Date): string {
  const short = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
  }).format(now);
  const index: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return WEEKDAY_ZH[index[short] ?? 0] ?? "一";
}

export function shanghaiDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const utc = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1) + days * 86_400_000;
  return new Date(utc).toISOString().slice(0, 10);
}

export function daysBetween(startIso: string, endIso: string): number {
  const [ys, ms, ds] = startIso.split("-").map(Number);
  const [ye, me, de] = endIso.split("-").map(Number);
  const start = Date.UTC(ys ?? 1970, (ms ?? 1) - 1, ds ?? 1);
  const end = Date.UTC(ye ?? 1970, (me ?? 1) - 1, de ?? 1);
  return Math.round((end - start) / 86_400_000);
}

export function shanghaiMinutes(now: Date): number {
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  const match = /(\d{1,2}):(\d{2})/.exec(text);
  if (!match?.[1] || !match[2]) return 0;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return (hour === 24 ? 0 : hour) * 60 + minute;
}

const WEEKDAY_INDEX: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

export function isUnsetWhen(label: string | null | undefined): boolean {
  if (label == null) return true;
  const text = label.trim();
  if (!text) return true;
  return /^(?:日期未定|时间未定|未定|待定|不确定|没定|还没定|tbd)$/i.test(text);
}

const WEEK_OFFSET: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 };

/** Monday of the next calendar week in Asia/Shanghai. Today being Monday still jumps seven days. */
export function nextWeekMonday(now: Date): string {
  const today = shanghaiDate(now);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
  }).format(now);
  const index: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = index[weekday] ?? 0;
  const sinceMonday = (day + 6) % 7;
  return addDays(today, 7 - sinceMonday);
}

/** `name` is 一…日/天. `monday` is the Monday that opens that week. */
export function weekdayInWeek(monday: string, name: string): string | null {
  const offset = WEEK_OFFSET[name];
  if (offset == null) return null;
  return addDays(monday, offset);
}

export function inferWeekdayDate(label: string, now: Date): string | null {
  const week = label.match(/(?:星期|礼拜|周)([一二三四五六日天])/);
  if (!week?.[1]) {
    if (label.includes("周末")) return inferStartDate(label, now);
    return null;
  }
  const target = WEEKDAY_INDEX[week[1]];
  if (target == null) return null;
  const today = shanghaiDate(now);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
  }).format(now);
  const index: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = index[weekday] ?? 0;
  return addDays(today, (target - day + 7) % 7);
}

/** Forecast length that reaches the last trip day, counting from today. */
export function forecastDaysThrough(startDate: string, tripDays: number, now = new Date()): number {
  const today = shanghaiDate(now);
  const safeDays = Math.max(1, Math.round(tripDays) || 1);
  const end = addDays(startDate, safeDays - 1);
  const span = daysBetween(today, end);
  if (!Number.isFinite(span) || span < 0) return 1;
  return Math.min(16, span + 1);
}

export function inferStartDate(whenLabel: string | null, now: Date): string {
  const today = shanghaiDate(now);
  const label = whenLabel?.trim() ?? "";
  if (!label || isUnsetWhen(label)) return addDays(today, 1);
  if (/今天|今日|今晚|已经出发|已经在路上|已经到了|正在爬|人已经在/.test(label)) return today;
  if (/后天/.test(label)) return addDays(today, 2);
  if (/明天|明日/.test(label)) return addDays(today, 1);
  if (!label.includes("周末")) return today;
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
  }).format(now);
  const index: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = index[weekday] ?? 0;
  if (day === 6 || day === 0) return today;
  return addDays(today, 6 - day);
}

export function targetDayIndex(
  book: Pick<Roadbook, "startDate" | "items">,
  now = new Date(),
): { dayIndex: number; outOfRange: boolean } {
  const today = shanghaiDate(now);
  const diff = daysBetween(book.startDate, today);
  const maxDay = book.items.reduce((max, item) => Math.max(max, item.dayIndex), 1);
  if (diff >= 0 && diff < maxDay) return { dayIndex: diff + 1, outOfRange: false };
  return { dayIndex: 1, outOfRange: true };
}
