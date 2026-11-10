import { citiesInText, longestCityPrefix, matchTravelRoute, mentionedCities, resolvePlaceToken } from "@lushu/tools/place";
import { CITIES } from "./cities";
import type { Party, PartyKind, Theme, TripSpec } from "./types";

const DIGIT: Record<string, number> = {
  零: 0,
  〇: 0,
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
};

const MINOR: Record<string, number> = { 千: 1000, 百: 100, 十: 10 };

const WEEKDAY: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
};

const THEME_RULES: { theme: Theme; re: RegExp }[] = [
  { theme: "food", re: /美食|小吃|吃货|早茶|糖水|夜宵|本地菜|餐饮/ },
  { theme: "family", re: /亲子|孩子|老人|父母|一家|带娃/ },
  { theme: "rain", re: /下雨|雨天|可能下雨|室内|备选/ },
  { theme: "slow", re: /慢慢|松弛|别太赶|不要赶|不要太特种兵|特种兵|不赶路/ },
  { theme: "business", re: /出差/ },
];

export function parseZhNumber(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (!/^[零〇一二两三四五六七八九十百千万]+$/.test(text)) return null;

  let total = 0;
  let section = 0;
  let number = 0;
  let lastUnit = 0;
  let sawUnit = false;

  for (const ch of text) {
    if (ch in DIGIT) {
      number = DIGIT[ch] ?? 0;
      continue;
    }
    if (ch === "万") {
      section += number;
      total += (section || 1) * 10_000;
      section = 0;
      number = 0;
      lastUnit = 10_000;
      sawUnit = true;
      continue;
    }
    if (ch in MINOR) {
      const unit = MINOR[ch] ?? 1;
      section += (number || 1) * unit;
      number = 0;
      lastUnit = unit;
      sawUnit = true;
    }
  }

  if (!sawUnit) return number || null;
  if (number > 0 && number < 10 && (lastUnit === 1000 || lastUnit === 10_000)) {
    const implied = lastUnit === 1000 ? 100 : 1000;
    return total + section + number * implied;
  }
  const value = total + section + number;
  return value > 0 ? value : null;
}

function clampDays(days: number): number {
  return Math.min(14, Math.max(1, Math.round(days)));
}

function extractDays(brief: string): { days: number; assumed: boolean } {
  const explicit = brief.match(/(\d+|[零〇一二两三四五六七八九十]+)\s*天/);
  if (explicit?.[1]) {
    const n = parseZhNumber(explicit[1]);
    if (n && n > 0) return { days: clampDays(n), assumed: n > 14 };
  }
  const span = brief.match(/周([一二三四五六日天])\s*到\s*周([一二三四五六日天])/);
  if (span?.[1] && span[2]) {
    const start = WEEKDAY[span[1]];
    const end = WEEKDAY[span[2]];
    if (start && end) {
      let diff = end - start;
      if (diff < 0) diff += 7;
      return { days: clampDays(diff + 1), assumed: false };
    }
  }
  // 「当天」 alone is not a 1-day trip. 回 / 往返, or 一日游, is.
  if (/当天回|当日回|当天往返|当日往返|一日游/.test(brief)) return { days: 1, assumed: false };
  if (/周末/.test(brief)) return { days: 2, assumed: false };
  if (/一周/.test(brief)) return { days: 7, assumed: false };
  return { days: 3, assumed: true };
}

function extractWhen(brief: string): string | null {
  const rules = [
    /今天|今日|今晚/,
    /已经出发|已经在路上|已经到了|正在爬|人已经在/,
    /下周末|这个周末|周末/,
    /春节/,
    /国庆/,
    /清明节?/,
    /五一/,
    /端午/,
    /元旦/,
    /下周三\s*到\s*周五|下周[一二三四五六日天]/,
    /后天/,
    /明天|明日/,
    /(五月|六月|七月|八月|九月|十月|十一月|十二月|一月|二月|三月|四月|春天|夏天|秋天|冬天)/,
  ];
  for (const rule of rules) {
    const match = brief.match(rule);
    if (match?.[0]) return match[0];
  }
  return null;
}

function extractOrigin(brief: string): string | null {
  const match = brief.match(/从\s*([\u4e00-\u9fa5]{2,8}?)\s*(?:出发|前往|去|到|往)/);
  if (!match?.[1]) return null;
  const known = longestCityPrefix(match[1]);
  if (known) return known;
  const token = match[1].replace(/(出发|前往|去往)$/u, "");
  return token || null;
}

function extractDestinations(brief: string, origin: string | null): string[] {
  const route = matchTravelRoute(brief);
  if (route) {
    const dest = resolvePlaceToken(route.to);
    if (dest) return [dest];
  }
  const found: { index: number; name: string }[] = [];
  for (const city of mentionedCities(brief)) {
    found.push({ index: city.index, name: city.name });
  }
  for (const hit of citiesInText(brief)) {
    if (!found.some((item) => item.name === hit.city)) {
      found.push({ index: hit.index, name: hit.city });
    }
  }
  found.sort((a, b) => a.index - b.index);
  let names = [...new Set(found.map((item) => item.name))];
  if (origin && names.includes(origin) && names.length > 1) {
    names = names.filter((name) => name !== origin);
  }
  if (names.length === 0) {
    const going = brief.match(/去\s*([\u4e00-\u9fa5]{2,8})/);
    const token = going?.[1] ? resolvePlaceToken(going[1]) : null;
    if (token && token !== origin) return [token];
    return origin ? [origin] : ["未写明的目的地"];
  }
  return names;
}

function extractBudget(brief: string): { text: string | null; amount: number | null } {
  const match = brief.match(
    /预算(?:大约|约|大概|在)?\s*([0-9]+(?:\.[0-9]+)?|[零〇一二两三四五六七八九十百千万]+)\s*(万)?/,
  );
  if (!match?.[1]) return { text: null, amount: null };
  const value = parseZhNumber(match[1]);
  if (value == null) return { text: match[0], amount: null };
  return { text: match[0], amount: match[2] ? value * 10_000 : value };
}

function extractParty(brief: string): Party {
  const family = brief.match(/一家\s*([0-9一二两三四五六七八九十])\s*口/);
  if (family?.[1]) {
    const count = parseZhNumber(family[1]) ?? 3;
    return { summary: `一家${family[1]}口`, count, kind: "family" };
  }
  if (/父母/.test(brief)) {
    return { summary: "和父母一起，按 3 人估算", count: 3, kind: "family" };
  }
  if (/孩子|亲子|老人|带娃/.test(brief)) {
    return { summary: "有孩子或老人同行", count: null, kind: "family" };
  }
  const people = brief.match(/([0-9一二两俩三四五六七八九十])\s*个?人/);
  if (people?.[1]) {
    const token = people[1] === "俩" ? "两" : people[1];
    const count = parseZhNumber(token);
    if (count === 1) return { summary: "一个人", count: 1, kind: "solo" };
    if (count === 2) return { summary: "两个人", count: 2, kind: "couple" };
    if (count) return { summary: `${count} 个人`, count, kind: "friends" };
  }
  if (/独自|单人/.test(brief)) return { summary: "一个人", count: 1, kind: "solo" };
  if (/大学生/.test(brief) && !/朋友/.test(brief)) {
    return { summary: "一个人，按学生预算", count: 1, kind: "solo" };
  }
  if (/出差/.test(brief)) return { summary: "一个人出差", count: 1, kind: "business" };
  return { summary: "人数没写清，按 2 人估算", count: 2, kind: "unknown" };
}

/** A count the brief actually wrote, such as 两个人 or 三人. The default 2 is not stated. */
export function statedPartyCount(brief: string): number | null {
  if (!/(?:[0-9一二两俩三四五六七八九十]\s*个?人|一家\s*[0-9一二两三四五六七八九十]\s*口|独自|单人)/.test(brief)) {
    return null;
  }
  const party = extractParty(brief);
  if (party.kind === "unknown" || party.count == null) return null;
  return party.count;
}

function extractThemes(brief: string, destinations: string[], budgetTight: boolean): Theme[] {
  const themes = new Set<Theme>();
  for (const rule of THEME_RULES) {
    if (rule.re.test(brief)) themes.add(rule.theme);
  }
  if (budgetTight) themes.add("budget");
  if (destinations.some((name) => CITIES.find((city) => city.name === name)?.outbound)) {
    themes.add("outbound");
  }
  if (themes.size === 0) themes.add("classic");
  return [...themes];
}

function extractConstraints(brief: string): string[] {
  const constraints: string[] = [];
  if (/不含往返|不含机票|不含火车/.test(brief)) constraints.push("预算不含往返大交通");
  if (/不要购物|不想购物/.test(brief)) constraints.push("不安排购物");
  if (/迪士尼/.test(brief)) constraints.push("希望安排一天迪士尼");
  if (/园林/.test(brief)) constraints.push("想看园林");
  if (/早上出门|避开整点|排队/.test(brief)) constraints.push("尽量早上出门，避开整点排队");
  const child = brief.match(/孩子\s*(\d+)\s*岁/);
  if (child?.[1]) constraints.push(`孩子大约 ${child[1]} 岁`);
  if (/町家/.test(brief)) constraints.push("希望住在町家附近");
  return constraints;
}

export function parseBrief(brief: string): TripSpec {
  const rawBrief = brief.trim();
  const origin = extractOrigin(rawBrief);
  const destinations = extractDestinations(rawBrief, origin);
  const { days, assumed } = extractDays(rawBrief);
  const budget = extractBudget(rawBrief);
  const party = extractParty(rawBrief);
  const budgetTight =
    /穷游|预算紧|预算低|省钱|大学生/.test(rawBrief) ||
    (budget.amount != null && budget.amount <= 150 * days);
  const themes = extractThemes(rawBrief, destinations, budgetTight);
  if (party.kind === "business" && !themes.includes("business")) themes.push("business");
  return {
    destinations,
    origin,
    days,
    daysAssumed: assumed,
    party,
    budgetText: budget.text,
    budgetAmountCny: budget.amount,
    budgetTight,
    themes,
    constraints: extractConstraints(rawBrief),
    whenLabel: extractWhen(rawBrief),
    rawBrief,
  };
}

export function isPartyKind(value: string): value is PartyKind {
  return ["solo", "couple", "family", "friends", "business", "unknown"].includes(value);
}
