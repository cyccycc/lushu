import type { Roadbook, RoadbookItem, WeatherSnap } from "./types";

export type SharedItem = Pick<
  RoadbookItem,
  | "id"
  | "dayIndex"
  | "startTime"
  | "durationMinutes"
  | "title"
  | "place"
  | "type"
  | "status"
  | "source"
  | "travelEstimateMinutes"
  | "estimateSource"
  | "priority"
  | "indoor"
  | "note"
>;

/** Itinerary a companion may see. Built by copying allowed fields, not by deleting secrets off the owner book. */
export type SharedItinerary = {
  id: string;
  title: string;
  city: string;
  startDate: string;
  updatedAt: string;
  items: SharedItem[];
  weather: WeatherSnap[];
};

function shareItem(item: RoadbookItem): SharedItem {
  const source = {
    kind: item.source.kind,
    ...(item.source.url ? { url: item.source.url } : {}),
    ...(item.source.fetchedAt ? { fetchedAt: item.source.fetchedAt } : {}),
    ...(item.source.note ? { note: item.source.note } : {}),
  };
  const shared: SharedItem = {
    id: item.id,
    dayIndex: item.dayIndex,
    startTime: item.startTime,
    durationMinutes: item.durationMinutes,
    title: item.title,
    place: item.place,
    type: item.type,
    status: item.status,
    source,
    travelEstimateMinutes: item.travelEstimateMinutes,
    estimateSource: item.estimateSource,
    priority: item.priority,
    indoor: item.indoor,
  };
  if (item.note) shared.note = item.note;
  return shared;
}

function shareWeather(snap: WeatherSnap): WeatherSnap {
  return {
    city: snap.city,
    query: snap.query,
    date: snap.date,
    condition: snap.condition,
    tempMinC: snap.tempMinC,
    tempMaxC: snap.tempMaxC,
    precipProbability: snap.precipProbability,
    available: snap.available,
    note: snap.note,
    fetchedAt: snap.fetchedAt,
    sourceUrl: snap.sourceUrl,
  };
}

/**
 * Companion payload. Brief, assumptions, undo, ownerId, checklist, and any
 * main-plan snapshot stay on the server. Nested snapshots are not copied.
 */
export function shareView(book: Roadbook): SharedItinerary {
  return {
    id: book.id,
    title: book.title,
    city: book.city,
    startDate: book.startDate,
    updatedAt: book.updatedAt,
    items: book.items.map(shareItem),
    weather: book.weather.map(shareWeather),
  };
}

export type BookKeyKind = "owner" | "share" | "none";

/** A share key is never an owner key, even when it is sent as the book key. */
export function classifyBookKey(presented: string, accessKey: string, shareKey?: string): BookKeyKind {
  const key = presented.trim();
  if (!key) return "none";
  if (key === accessKey) return "owner";
  if (shareKey && key === shareKey) return "share";
  return "none";
}
