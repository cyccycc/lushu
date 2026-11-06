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

export function endMinutes(startTime: string, durationMinutes: number): number | null {
  const start = parseTime(startTime);
  if (start == null) return null;
  return start + durationMinutes;
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

export function inferStartDate(whenLabel: string | null, now: Date): string {
  const today = shanghaiDate(now);
  if (!whenLabel || !whenLabel.includes("周末")) return today;
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
