import { guideFor } from "./cities";
import type { ItineraryDay, PlanSupplement, PlanVariant, TripSpec } from "./types";

const HOTEL_RE = /酒店|住宿|住哪|宾馆|民宿|落脚/;
const TAXI_RE = /打车|出租|出租车|网约车|怎么走|路线/;
const REVISE_RE = /改时间|提前|推迟|延后|改到|换成|不要去|删掉|加一天|少一天|多一天|去掉一天|再出门|出发/;

function supplementId(existing: PlanSupplement[], kind: PlanSupplement["kind"]): string {
  const count = existing.filter((item) => item.kind === kind).length + 1;
  return `${kind}-${count}`;
}

function mentionedDay(prompt: string): number | null {
  const digit = prompt.match(/第\s*(\d+)\s*天/);
  if (digit?.[1]) return Number(digit[1]);
  const words: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  const zh = prompt.match(/第\s*([一二两三四五六七八九十])\s*天/);
  if (zh?.[1] && words[zh[1]]) return words[zh[1]];
  return null;
}

function hotelBody(variant: PlanVariant, spec: TripSpec): string {
  const cities = [...new Set(variant.days.map((day) => day.city))];
  const lines = [
    `按${spec.party.summary}比较住宿大概落在哪一带，方便你自己查。只做比较，路书不代订、不锁房、不收款，也没有预订入口。`,
  ];
  for (const city of cities) {
    const guide = guideFor(city);
    const areas = [...new Set(guide.places.map((place) => place.area))].slice(0, 3);
    lines.push(`${city}：${guide.stayNote}`);
    if (areas.length > 0) {
      lines.push(`可以对比的区域：${areas.join("、")}。景区门口通常更贵更吵，换乘少的城区更适合多走几天。价格以你查到的当晚页面为准，这里不报实价。`);
    }
  }
  return lines.join("\n");
}

function taxiBody(variant: PlanVariant): string {
  const lines = ["下面只是当天点位的衔接顺序，用来估计要不要打车。路书不叫车，也不跳转下单。"];
  for (const day of variant.days) {
    const stops = day.items.map((item) => (item.area ? `${item.title}（${item.area}）` : item.title));
    lines.push(
      `第 ${day.day} 天 · ${day.city}：${stops.join(" → ")}。同一片区优先步行；跨区再考虑打车，高峰和雨天多留 20 分钟。`,
    );
  }
  return lines.join("\n");
}

function shiftDay(day: ItineraryDay, prompt: string, force: boolean): ItineraryDay {
  if (!force || day.items.length === 0) return day;
  const items = day.items.map((item) => ({ ...item }));
  const first = items[0];
  if (!first) return day;
  if (/下午/.test(prompt)) {
    items[0] = { ...first, time: "下午", detail: `${first.detail} 按补充改到下午再开始。` };
    return { ...day, items };
  }
  if (/提前|上午/.test(prompt)) {
    items[0] = { ...first, time: "早上", detail: `${first.detail} 按补充提前到早上。` };
    return { ...day, items };
  }
  if (/推迟|延后|晚上/.test(prompt)) {
    items[0] = { ...first, time: "晚上", detail: `${first.detail} 按补充改到晚上。` };
    return { ...day, items };
  }
  items[0] = {
    ...first,
    time: "时间待定",
    detail: `${first.detail} 你要改时间，但还没写新的钟点。这一项先标成待定。`,
  };
  return { ...day, items };
}

function reviseDays(variant: PlanVariant, prompt: string): ItineraryDay[] {
  let days = variant.days.map((day) => ({
    ...day,
    items: day.items.map((item) => ({ ...item })),
  }));
  const target = mentionedDay(prompt);
  const inScope = (day: ItineraryDay, fallbackDay: number) =>
    target == null ? day.day === fallbackDay : day.day === target;

  if (/加一天|多一天/.test(prompt)) {
    const last = days[days.length - 1];
    if (last) {
      days.push({
        ...last,
        day: days.length + 1,
        title: "多留的一天",
        theme: "按补充加出",
        items: [
          {
            time: "全天",
            title: "留白",
            detail: "按你的补充多排一天。具体去哪可以再写一句。路书不为此订票。",
            area: last.city,
          },
        ],
      });
    }
  }
  if (/少一天|去掉一天/.test(prompt) && days.length > 1) {
    days = days.slice(0, -1).map((day, index) => ({ ...day, day: index + 1 }));
  }

  const drop = prompt.match(/(?:不要去|删掉)\s*([\u4e00-\u9fa5A-Za-z0-9]{2,16})/);
  if (drop?.[1]) {
    const name = drop[1];
    days = days.map((day) => {
      if (target != null && day.day !== target) return day;
      const kept = day.items.filter((item) => !item.title.includes(name));
      return kept.length > 0 ? { ...day, items: kept } : day;
    });
  }

  if (/改时间|提前|推迟|延后|改到|再出门|下午|上午|晚上/.test(prompt)) {
    days = days.map((day) => shiftDay(day, prompt, inScope(day, 1)));
  }
  return days;
}

export function applyPlanFollowUp(
  variant: PlanVariant,
  spec: TripSpec,
  prompt: string,
): { variant: PlanVariant; summary: string } {
  const text = prompt.trim();
  const supplements = [...(variant.supplements ?? [])];
  const notes: string[] = [];
  let next: PlanVariant = variant;
  const refusal = /预订|预定|下单|付款|支付|购票/.test(text)
    ? "路书不预订、不叫车、不收款。"
    : "";

  if (HOTEL_RE.test(text)) {
    supplements.push({
      id: supplementId(supplements, "hotel"),
      title: "住宿比较",
      kind: "hotel",
      body: hotelBody(variant, spec),
    });
    notes.push("已把住宿比较写进这份行程");
  }
  if (TAXI_RE.test(text)) {
    supplements.push({
      id: supplementId(supplements, "taxi"),
      title: "打车路线建议",
      kind: "taxi",
      body: taxiBody(variant),
    });
    notes.push("已把打车衔接写进这份行程");
  }
  if (REVISE_RE.test(text)) {
    const days = reviseDays(variant, text);
    supplements.push({
      id: supplementId(supplements, "revise"),
      title: "按你的补充调整",
      kind: "revise",
      body: `已按「${text}」改在这份行程上。${refusal || "仍然只是计划，不改签、不订票。"}`,
    });
    next = {
      ...variant,
      days,
      assumptions: [...variant.assumptions, `后续补充：${text}`].slice(0, 12),
    };
    notes.push("已改在原行程上");
  }
  if (notes.length === 0) {
    supplements.push({
      id: supplementId(supplements, "note"),
      title: "补充",
      kind: "note",
      body: `你说：「${text}」。${refusal || "这句话记在同一份行程上，没有另开一趟。"}若要改某一天，直接写「第2天下午再出门」；找住处或路线，写「找酒店」或「打车路线」。只给建议，不代订。`,
    });
    notes.push("已记在这份行程上");
  }

  return {
    variant: { ...next, supplements: supplements.slice(-8) },
    summary: [refusal, notes.join("；")].filter(Boolean).join(""),
  };
}
