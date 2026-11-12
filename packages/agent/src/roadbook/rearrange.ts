import { guideFor } from "../cities";
import { projectPatch } from "./patch";
import { DAY_END_MINUTES, endMinutes, formatTime, parseTime, shanghaiMinutes, targetDayIndex } from "./time";
import { snapForTripDay } from "./weather";
import type { PatchOp, Plan, Priority, Roadbook, RoadbookItem } from "./types";

function cutRank(item: RoadbookItem): number {
  if (item.type === "办事" || item.locked || item.status !== "待做" || item.priority === "必去") return 1000;
  if (item.type === "交通") return 80;
  if (item.type === "餐") return 70;
  if (item.type === "景点" && item.priority === "想去") return 50;
  if (item.priority === "想去") return 40;
  if (item.type === "休息") return 10;
  if (item.type === "自由") return 0;
  if (item.priority === "可砍") return 5;
  return 30;
}

function pickCut(items: RoadbookItem[]): RoadbookItem | null {
  const candidates = items.filter((item) => cutRank(item) < 1000);
  candidates.sort((a, b) => {
    const rank = cutRank(a) - cutRank(b);
    if (rank !== 0) return rank;
    return (parseTime(b.startTime) ?? 0) - (parseTime(a.startTime) ?? 0);
  });
  return candidates[0] ?? null;
}

function overflowItem(items: RoadbookItem[], dayIndex: number): RoadbookItem | undefined {
  return items.find((item) => {
    if (item.dayIndex !== dayIndex || item.locked || item.status !== "待做" || item.priority === "必去") return false;
    const start = parseTime(item.startTime);
    if (start == null) return false;
    return start + item.durationMinutes > DAY_END_MINUTES;
  });
}

function stillOpen(item: RoadbookItem, nowMinutes: number, useClock: boolean): boolean {
  if (!useClock) return true;
  const end = endMinutes(item.startTime, item.durationMinutes);
  if (end == null) return true;
  return end > nowMinutes;
}

function isStationRun(item: RoadbookItem): boolean {
  return item.title === "去车站";
}

function isReturnRide(item: RoadbookItem): boolean {
  return item.type === "交通" && item.title.startsWith("返回");
}

function slotFree(items: RoadbookItem[], day: number, start: number, duration: number): boolean {
  return !items.some((item) => {
    if (item.dayIndex !== day) return false;
    const other = parseTime(item.startTime);
    if (other == null) return false;
    return start < other + item.durationMinutes && start + duration > other;
  });
}

/** A 40-minute rest that finishes by `depart`, closest to the preferred clock. */
function findRestSlot(items: RoadbookItem[], day: number, preferred: number, depart: number, floor: number): number | null {
  const latest = depart - 40;
  if (latest < floor) return null;
  const candidates: number[] = [];
  if (preferred >= floor && preferred <= latest && slotFree(items, day, preferred, 40)) candidates.push(preferred);
  const start = Math.ceil(floor / 10) * 10;
  for (let time = start; time <= latest; time += 10) {
    if (slotFree(items, day, time, 40)) candidates.push(time);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || a - b);
  return candidates[0] ?? null;
}

export function planLate(book: Roadbook, now = new Date()): Plan {
  const target = targetDayIndex(book, now);
  const nowMinutes = shanghaiMinutes(now);
  const station = book.items.find((item) => item.dayIndex === target.dayIndex && isStationRun(item));
  const cutoff = station ? parseTime(station.startTime) : null;
  const movable = book.items.filter(
    (item) =>
      item.dayIndex === target.dayIndex &&
      item.status === "待做" &&
      !item.locked &&
      !isStationRun(item) &&
      !isReturnRide(item) &&
      stillOpen(item, nowMinutes, !target.outOfRange),
  );
  const prefix = target.outOfRange ? "今天不在行程日期里，已按第 1 天试算。" : "";
  if (movable.length === 0) {
    return { request: null, note: `${prefix}没有能顺延的未完成项。`.trim() };
  }
  const removed = new Set<string>();
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const ops: PatchOp[] = [];
    for (const id of removed) ops.push({ op: "remove", id });
    let shifted = 0;
    for (const item of movable) {
      if (removed.has(item.id)) continue;
      const start = parseTime(item.startTime);
      if (start == null) return { request: null, note: `「${item.title}」的时间无法解析。` };
      if (start + 60 >= 24 * 60 || (cutoff != null && start + 60 >= cutoff)) {
        removed.add(item.id);
        continue;
      }
      ops.push({
        op: "update",
        id: item.id,
        fields: { startTime: formatTime(start + 60) },
      });
      shifted += 1;
    }
    if (shifted === 0 && removed.size === 0) {
      return { request: null, note: "没有能顺延的时间。" };
    }
    const projected = projectPatch(book, { label: "晚了 1 小时", kind: "late", ops });
    if (!projected.ok) {
      const victim = pickCut(movable.filter((item) => !removed.has(item.id)));
      if (!victim) return { request: null, note: projected.error };
      removed.add(victim.id);
      continue;
    }
    const spilled =
      cutoff == null
        ? []
        : projected.items.filter((item) => {
            if (item.dayIndex !== target.dayIndex || item.locked || isStationRun(item) || isReturnRide(item)) return false;
            const start = parseTime(item.startTime);
            return start != null && start >= cutoff;
          });
    if (spilled.length > 0) {
      for (const item of spilled) removed.add(item.id);
      continue;
    }
    const stationAfter = projected.items.find((item) => item.dayIndex === target.dayIndex && isStationRun(item));
    if (station && stationAfter && stationAfter.startTime !== station.startTime) {
      const pusher = projected.items.find(
        (item) => item.dayIndex === target.dayIndex && !item.locked && !isStationRun(item) && removed.has(item.id) === false,
      );
      if (pusher) {
        removed.add(pusher.id);
        continue;
      }
    }
    const late = overflowItem(projected.items, target.dayIndex);
    if (!late) {
      const cutTitles = book.items.filter((item) => removed.has(item.id)).map((item) => item.title);
      const cut = cutTitles.length ? `放不下，砍了${cutTitles.join("、")}。` : "未完成的项顺延 1 小时。";
      const note = `${prefix}${cut}`.trim();
      return {
        request: { label: "晚了 1 小时", kind: "late", ops, statusNote: note },
        note,
      };
    }
    const victim = pickCut(projected.items.filter((item) => item.dayIndex === target.dayIndex)) ?? late;
    if (cutRank(victim) >= 1000) {
      const note = `${prefix}必去项会晚于 21:30，已保留并顺延其余项。`.trim();
      return {
        request: { label: "晚了 1 小时", kind: "late", ops, statusNote: note },
        note,
      };
    }
    removed.add(victim.id);
  }
  return { request: null, note: "没能把今天排进 21:30 之前。" };
}

function weatherLine(book: Roadbook, dayIndex: number): string {
  const picked = snapForTripDay(book, dayIndex);
  if (!picked || !picked.available) return "没有这一天的预报，仍按雨天改了户外项。";
  const precip = picked.precipProbability == null ? "降水未知" : `降水 ${picked.precipProbability}%`;
  return `预报 ${picked.condition}，${precip}。`;
}

function rainAsk(title: string, alternative: string | null): string {
  const suggestion = alternative ? `室内可以改去${alternative}。` : "";
  return `${title}是户外，下雨要不要去？${suggestion}`;
}

export function planRain(book: Roadbook, now = new Date()): Plan {
  const target = targetDayIndex(book, now);
  const prefix = target.outOfRange ? "今天不在行程日期里，已按第 1 天试算。" : "";
  const guide = guideFor(book.city);
  const indoor = guide.places.filter((place) => place.indoor);
  const used = new Set(book.items.map((item) => item.title));
  const ops: PatchOp[] = [];
  const lockedOutdoor: { id: string; title: string }[] = [];
  const asks: { text: string; itemId: string }[] = [];
  for (const item of book.items) {
    if (item.dayIndex !== target.dayIndex || item.status !== "待做") continue;
    if (isStationRun(item)) continue;
    if (item.type !== "景点" || item.indoor) continue;
    if (item.locked) {
      lockedOutdoor.push({ id: item.id, title: item.title });
      continue;
    }
    if (item.priority === "必去") {
      const alt = indoor.find((place) => !used.has(place.name));
      if (alt) used.add(alt.name);
      asks.push({ text: rainAsk(item.title, alt?.name ?? null), itemId: item.id });
      continue;
    }
    const alt = indoor.find((place) => !used.has(place.name));
    if (alt) {
      used.add(alt.name);
      ops.push({
        op: "update",
        id: item.id,
        fields: {
          title: alt.name,
          place: `${book.city} · ${alt.area}`,
          indoor: true,
          durationMinutes: Math.min(item.durationMinutes, 120),
          note: `下雨改室内。原来是「${item.title}」。${alt.detail}`,
          source: { kind: "推断", note: "雨天规则" },
        },
      });
      continue;
    }
    ops.push({
      op: "update",
      id: item.id,
      fields: {
        title: `${item.title}（改室内）`,
        indoor: true,
        durationMinutes: Math.min(item.durationMinutes, 90),
        note: "没有现成的室内替身，这项改成室内停留，场馆请出发前核实。",
        source: { kind: "推断", note: "雨天规则" },
      },
    });
  }
  if (ops.length === 0 && lockedOutdoor.length === 0 && asks.length === 0) {
    return { request: null, note: `${prefix}今天没有需要改的户外景点。`.trim() };
  }
  const forecast = weatherLine(book, target.dayIndex);
  const lockedTitles = lockedOutdoor.map((item) => item.title).join("、");
  const kept = lockedOutdoor.length ? `锁定的户外仍保留：${lockedTitles}。` : "";
  const askText = asks.map((item) => item.text).join("");
  const changed = ops.length ? "其他户外景点已改成室内。" : "";
  const note = `${prefix}${forecast}${askText}${kept}${changed}`.trim();
  const verifyAdds = [
    ...(lockedOutdoor.length
      ? [
          {
            text: `锁定的户外仍保留：${lockedTitles}。下雨要不要去，自己定。`,
            ...(lockedOutdoor.length === 1 && lockedOutdoor[0] ? { itemId: lockedOutdoor[0].id } : {}),
          },
        ]
      : []),
    ...asks,
  ];
  return {
    request: {
      label: asks[0]?.text ?? "下雨了",
      kind: "rain",
      ops,
      statusNote: note,
      verifyAdds,
    },
    note,
  };
}

let restSerial = 0;

const CLIMB_RE = /泰山|黄山|华山|衡山|恒山|嵩山|峨眉|庐山|普陀山|青城山|武当山|雁荡山|长白山|五台山|登山|爬山|徒步|登顶/;

function keepsLongVisit(item: RoadbookItem): boolean {
  if (item.type !== "景点" || item.indoor) return false;
  if (item.durationMinutes >= 300) return true;
  if (item.durationMinutes < 180) return false;
  const text = `${item.title}${item.place}${item.note ?? ""}`;
  if (CLIMB_RE.test(text)) return true;
  return item.priority === "必去";
}

export function planTired(book: Roadbook, now = new Date(), random?: () => string): Plan {
  const target = targetDayIndex(book, now);
  const prefix = target.outOfRange ? "今天不在行程日期里，已按第 1 天试算。" : "";
  const nowMinutes = shanghaiMinutes(now);
  const today = book.items.filter(
    (item) => item.dayIndex === target.dayIndex && item.status === "待做" && !item.locked && !isStationRun(item),
  );
  const station = book.items.find((item) => item.dayIndex === target.dayIndex && isStationRun(item));
  const stationStart = station ? parseTime(station.startTime) : null;
  if (today.length === 0) return { request: null, note: `${prefix}今天没有能减的未完成项。`.trim() };
  const ops: PatchOp[] = [];
  const cut: string[] = [];
  for (const item of today) {
    if (!stillOpen(item, nowMinutes, !target.outOfRange)) continue;
    const drop =
      item.type === "自由" ||
      (item.priority === "可砍" && item.type !== "餐" && item.type !== "交通" && item.type !== "休息");
    if (drop && item.priority !== "必去") {
      ops.push({ op: "remove", id: item.id });
      cut.push(item.title);
      continue;
    }
    if (item.type === "景点") {
      if (keepsLongVisit(item)) continue;
      const start = parseTime(item.startTime);
      const durationMinutes = Math.min(item.durationMinutes, 75);
      const useClock = !target.outOfRange;
      if (useClock && start != null && start <= nowMinutes && start + durationMinutes < nowMinutes) continue;
      const travel = item.travelEstimateMinutes == null ? 15 : Math.min(item.travelEstimateMinutes, 15);
      ops.push({
        op: "update",
        id: item.id,
        fields: {
          durationMinutes,
          travelEstimateMinutes: travel,
          note: item.note ? `${item.note} 累了，缩短停留、少走路。` : "累了，缩短停留、少走路。",
        },
      });
    }
  }
  const anchor = today.find((item) => item.type === "景点" && item.priority === "必去" && !cut.includes(item.title));
  const start = anchor ? parseTime(anchor.startTime) : 15 * 60;
  let restAt = start == null ? 15 * 60 : Math.min(start + 75, 16 * 60);
  if (!target.outOfRange && restAt <= nowMinutes) restAt = nowMinutes + 10;
  const ride = book.items.find((item) => item.dayIndex === target.dayIndex && isReturnRide(item));
  const rideStart = ride ? parseTime(ride.startTime) : null;
  const departs = [stationStart, rideStart].filter((value): value is number => value != null);
  const depart = departs.length > 0 ? Math.min(...departs) : null;
  if (depart != null && restAt + 40 > depart) restAt = depart - 40;
  if (restAt > 23 * 60 || restAt < 8 * 60 || (depart != null && restAt + 40 > depart)) {
    if (ops.length === 0) return { request: null, note: `${prefix}今天剩下的时间排不下休息。`.trim() };
    const note = `${prefix}减了步行${cut.length ? `，砍了${cut.join("、")}` : ""}。去车站留在返程前。`.trim();
    return { request: { label: "累了", kind: "tired", ops, statusNote: note }, note };
  }
  if (depart != null) {
    const preview = projectPatch(book, { label: "累了", kind: "tired", ops });
    if (!preview.ok) return { request: null, note: preview.error };
    const floor = !target.outOfRange ? Math.max(8 * 60, nowMinutes + 10) : 8 * 60;
    const slot = findRestSlot(preview.items, target.dayIndex, restAt, depart, floor);
    if (slot == null) {
      if (ops.length === 0) return { request: null, note: `${prefix}今天剩下的时间排不下休息。`.trim() };
      const note = `${prefix}减了步行${cut.length ? `，砍了${cut.join("、")}` : ""}。返程前排不下休息。`.trim();
      return { request: { label: "累了", kind: "tired", ops, statusNote: note }, note };
    }
    restAt = slot;
  }
  const restStart = formatTime(restAt);
  restSerial += 1;
  const restId = `i_${random ? random() : `rest${restSerial}`}`;
  ops.push({
    op: "add",
    item: {
      id: restId,
      dayIndex: target.dayIndex,
      startTime: restStart,
      durationMinutes: 40,
      title: "坐下休息",
      place: book.city === "未写明的目的地" ? "待定" : book.city,
      lat: null,
      lng: null,
      type: "休息",
      status: "待做",
      source: { kind: "推断", note: "累了规则" },
      travelEstimateMinutes: 5,
      estimateSource: "推断",
      locked: false,
      priority: "想去" satisfies Priority,
      indoor: true,
      highlight: false,
      note: "少走一段，在这里停 40 分钟。",
    },
  });
  const projected = projectPatch(book, { label: "累了", kind: "tired", ops });
  if (!projected.ok) return { request: null, note: projected.error };
  if (depart != null) {
    const placed = projected.items.find((item) => item.id === restId);
    const placedStart = placed ? parseTime(placed.startTime) : null;
    if (placedStart == null || placedStart >= depart) {
      ops.pop();
      if (ops.length === 0) return { request: null, note: `${prefix}今天剩下的时间排不下休息。`.trim() };
      const held = `${prefix}减了步行${cut.length ? `，砍了${cut.join("、")}` : ""}。返程前排不下休息。`.trim();
      return { request: { label: "累了", kind: "tired", ops, statusNote: held }, note: held };
    }
  }
  const note = `${prefix}减了步行${cut.length ? `，砍了${cut.join("、")}` : ""}，加了休息。`.trim();
  return {
    request: { label: "累了", kind: "tired", ops, statusNote: note },
    note,
  };
}
