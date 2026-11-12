"use client";

import { useEffect, useState } from "react";
import {
  factMark,
  formatTime,
  parseTime,
  snapForTripDay,
  weatherMark,
  type SharedItinerary,
} from "@lushu/agent/roadbook";
import { RoadbookPoster } from "@/components/roadbook-poster";

function span(item: SharedItinerary["items"][number]): string {
  const start = parseTime(item.startTime);
  if (start == null) return item.startTime;
  return `${item.startTime}–${formatTime(Math.min(start + item.durationMinutes, 23 * 60 + 59))}`;
}

export function ShareScreen({ id, shareKey }: { id: string; shareKey: string }) {
  const [itinerary, setItinerary] = useState<SharedItinerary | null>(null);
  const [error, setError] = useState("");
  const [now] = useState(() => new Date());

  useEffect(() => {
    let cancel = false;
    void (async () => {
      const res = await fetch(`/api/roadbooks/${id}/share`, {
        headers: { "X-Lushu-Share-Key": shareKey },
        cache: "no-store",
      }).catch(() => null);
      if (cancel) return;
      if (!res || !res.ok) {
        setError(res?.status === 404 ? "这个分享链接已经失效。" : "打不开这份行程。");
        return;
      }
      const data = (await res.json()) as { itinerary?: SharedItinerary };
      if (!data.itinerary) {
        setError("打不开这份行程。");
        return;
      }
      setItinerary(data.itinerary);
    })();
    return () => {
      cancel = true;
    };
  }, [id, shareKey]);

  if (error) {
    return <main className="mx-auto flex h-dvh max-w-lg items-center px-4 text-sm">{error}</main>;
  }
  if (!itinerary) {
    return <main className="grid h-dvh place-items-center text-sm text-muted-foreground">正在打开行程…</main>;
  }
  const days = [...new Set(itinerary.items.map((item) => item.dayIndex))].sort((a, b) => a - b);
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col px-4 py-4">
      <header className="space-y-1">
        <p className="text-xs text-muted-foreground">路书 · 只读</p>
        <h1 className="font-serif text-2xl leading-tight">{itinerary.title}</h1>
        <p className="text-xs text-muted-foreground">{itinerary.city}</p>
      </header>
      <div className="mt-4 space-y-4">
        {days.map((day) => {
          const weather = weatherMark(snapForTripDay(itinerary, day), now);
          return (
            <section key={day} className="space-y-2">
              <h2 className="text-sm font-medium">
                第 {day} 天 · {weather.heading}
                {weather.stale ? " · 可能过时" : ""}
              </h2>
              {itinerary.items
                .filter((item) => item.dayIndex === day)
                .sort((a, b) => (parseTime(a.startTime) ?? 0) - (parseTime(b.startTime) ?? 0))
                .map((item) => {
                  const mark = factMark(item, now);
                  return (
                    <article key={item.id} className="rounded-2xl border border-border bg-card px-3 py-2">
                      <p className="text-sm font-medium">
                        {span(item)} {item.title}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {item.place} · {item.type} · {item.priority}
                        {item.indoor ? " · 室内" : ""}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        <span data-source={mark.kind}>{mark.kind}</span>
                        {mark.note && !(item.note ?? "").includes(mark.note) ? ` · ${mark.note}` : ""}
                        {mark.fetchedOn ? ` · ${mark.fetchedOn}` : ""}
                        {mark.url ? (
                          <>
                            {" · "}
                            <a href={mark.url} className="underline" target="_blank" rel="noreferrer">
                              来源
                            </a>
                          </>
                        ) : null}
                        {mark.unavailable ? " · 暂不可用" : ""}
                        {mark.stale ? " · 可能过时" : ""}
                        {mark.needsVerify ? " · 需要你核实" : ""}
                        {item.note ? ` · ${item.note}` : ""}
                      </p>
                    </article>
                  );
                })}
            </section>
          );
        })}
        <RoadbookPoster book={itinerary} />
      </div>
    </main>
  );
}
