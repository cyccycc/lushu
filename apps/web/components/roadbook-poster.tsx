"use client";

import { useEffect, useState } from "react";
import {
  factMark,
  formatTime,
  parseTime,
  snapForTripDay,
  weatherMark,
  type RoadbookItem,
  type SharedItinerary,
  type WeatherSnap,
} from "@lushu/agent/roadbook";

type PosterBook = {
  title: string;
  city: string;
  startDate: string;
  items: RoadbookItem[] | SharedItinerary["items"];
  weather: WeatherSnap[];
};

const SCALE = 3;
const WIDTH = 780;

function span(item: { startTime: string; durationMinutes: number }): string {
  const start = parseTime(item.startTime);
  if (start == null) return item.startTime;
  return `${item.startTime}–${formatTime(Math.min(start + item.durationMinutes, 23 * 60 + 59))}`;
}

function clockLabel(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    const next = line + ch;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = ch.trim() ? ch : "";
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

function factText(item: PosterBook["items"][number], now: Date): string {
  const mark = factMark(item, now);
  const parts: string[] = [mark.kind];
  if (mark.note && !(item.note ?? "").includes(mark.note)) parts.push(mark.note);
  if (mark.fetchedOn) parts.push(mark.fetchedOn);
  if (mark.url) parts.push("来源");
  if (mark.unavailable) parts.push("暂不可用");
  if (mark.stale) parts.push("可能过时");
  if (mark.needsVerify) parts.push("需要你核实");
  if (item.note) parts.push(item.note);
  return parts.join(" · ");
}

export function renderRoadbookPoster(book: PosterBook, day: number | "all", now: Date): string {
  const days = [...new Set(book.items.map((item) => item.dayIndex))]
    .filter((value) => day === "all" || value === day)
    .sort((a, b) => a - b);
  const logical = document.createElement("canvas");
  const measure = logical.getContext("2d");
  if (!measure) return "";
  const pad = 36;
  const inner = WIDTH - pad * 2;
  let height = pad;
  const blocks: { draw: (ctx: CanvasRenderingContext2D) => void; height: number }[] = [];
  const pushText = (text: string, font: string, color: string, gap: number) => {
    measure.font = font;
    const lines = wrap(measure, text, inner);
    const lineHeight = Number(font.match(/(\d+)px/)?.[1] ?? 16) + 8;
    const blockHeight = lines.length * lineHeight + gap;
    blocks.push({
      height: blockHeight,
      draw: (ctx) => {
        ctx.font = font;
        ctx.fillStyle = color;
        lines.forEach((line, index) => ctx.fillText(line, pad, height + (index + 1) * lineHeight - 6));
      },
    });
    height += blockHeight;
  };
  pushText(book.title, "600 32px 'Noto Serif SC', serif", "#1c1917", 8);
  pushText(`${book.city} · 截至 ${clockLabel(now)} 生成`, "16px sans-serif", "#57534e", 18);
  if (days.length === 0) pushText("这一天还没有行程。", "18px sans-serif", "#44403c", 12);
  for (const index of days) {
    const weather = weatherMark(snapForTripDay(book, index), now);
    const heading = weather.stale ? `${weather.heading} · 可能过时` : weather.heading;
    pushText(`第 ${index} 天 · ${heading}`, "600 20px sans-serif", "#1c1917", 8);
    const items = book.items
      .filter((item) => item.dayIndex === index)
      .sort((a, b) => (parseTime(a.startTime) ?? 0) - (parseTime(b.startTime) ?? 0));
    for (const item of items) {
      pushText(`${span(item)}  ${item.title}`, "600 18px sans-serif", "#1c1917", 2);
      pushText(`${item.place} · ${item.type} · ${item.priority}`, "15px sans-serif", "#57534e", 2);
      pushText(factText(item, now), "15px sans-serif", "#44403c", 12);
    }
  }
  height += pad;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH * SCALE;
  canvas.height = Math.max(1, Math.ceil(height * SCALE));
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = "#f7f4ee";
  ctx.fillRect(0, 0, WIDTH, height);
  height = pad;
  for (const block of blocks) {
    block.draw(ctx);
    height += block.height;
  }
  return canvas.toDataURL("image/png");
}

export function RoadbookPoster({ book }: { book: PosterBook }) {
  const days = [...new Set(book.items.map((item) => item.dayIndex))].sort((a, b) => a - b);
  const [day, setDay] = useState<number | "all">("all");
  const [url, setUrl] = useState("");
  const [generatedAt] = useState(() => new Date());
  useEffect(() => {
    let cancel = false;
    const draw = () => {
      if (!cancel) setUrl(renderRoadbookPoster(book, day, generatedAt));
    };
    if ("fonts" in document) void document.fonts.ready.then(draw);
    else draw();
    return () => {
      cancel = true;
    };
  }, [book, day, generatedAt]);
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">长图</h2>
      <p className="text-xs text-muted-foreground">图在页面上，长按就能保存。截至 {clockLabel(generatedAt)} 生成。</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={`rounded-full border px-3 py-1 text-xs ${day === "all" ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
          onClick={() => setDay("all")}
        >
          整份
        </button>
        {days.map((value) => (
          <button
            key={value}
            type="button"
            className={`rounded-full border px-3 py-1 text-xs ${day === value ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
            onClick={() => setDay(value)}
          >
            第 {value} 天
          </button>
        ))}
      </div>
      {url ? (
        // Data-URL bitmap for a long-press save. next/image cannot host that.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="行程长图，长按保存" className="h-auto w-full rounded-xl border border-border" />
      ) : (
        <p className="text-xs text-muted-foreground">正在生成长图…</p>
      )}
    </section>
  );
}
