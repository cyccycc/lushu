export type KnownCity = {
  name: string;
  english: string;
};

export type PlaceHit = {
  city: string;
  english: string;
  index: number;
  landmark: string;
};

/** Landmark phrases that must not be geocoded as a raw sentence. */
const LANDMARKS: { re: RegExp; city: string; english: string; landmark: string }[] = [
  { re: /西湖|灵隐|雷峰塔|断桥|河坊街|白堤|苏堤|龙井/, city: "杭州", english: "Hangzhou", landmark: "西湖" },
  { re: /外滩|豫园|武康路|陆家嘴/, city: "上海", english: "Shanghai", landmark: "外滩" },
  { re: /故宫|颐和园|天坛|什刹海/, city: "北京", english: "Beijing", landmark: "故宫" },
  { re: /兵马俑|大雁塔/, city: "西安", english: "Xi'an", landmark: "兵马俑" },
  { re: /宽窄巷子|锦里|武侯祠/, city: "成都", english: "Chengdu", landmark: "宽窄巷子" },
  { re: /拙政园|平江路|虎丘|山塘街/, city: "苏州", english: "Suzhou", landmark: "拙政园" },
  { re: /栈桥|八大关/, city: "青岛", english: "Qingdao", landmark: "栈桥" },
  { re: /洱海|崇圣寺/, city: "大理", english: "Dali", landmark: "洱海" },
  { re: /夫子庙|中山陵|玄武湖/, city: "南京", english: "Nanjing", landmark: "夫子庙" },
  { re: /鼓浪屿|曾厝垵/, city: "厦门", english: "Xiamen", landmark: "鼓浪屿" },
];

export const KNOWN_CITIES: KnownCity[] = [
  { name: "杭州", english: "Hangzhou" },
  { name: "上海", english: "Shanghai" },
  { name: "北京", english: "Beijing" },
  { name: "苏州", english: "Suzhou" },
  { name: "南京", english: "Nanjing" },
  { name: "成都", english: "Chengdu" },
  { name: "西安", english: "Xi'an" },
  { name: "广州", english: "Guangzhou" },
  { name: "青岛", english: "Qingdao" },
  { name: "大理", english: "Dali" },
  { name: "昆明", english: "Kunming" },
  { name: "丽江", english: "Lijiang" },
  { name: "深圳", english: "Shenzhen" },
  { name: "东京", english: "Tokyo" },
  { name: "京都", english: "Kyoto" },
  { name: "厦门", english: "Xiamen" },
  { name: "济南", english: "Jinan" },
  { name: "武汉", english: "Wuhan" },
];

export function citiesInText(text: string): PlaceHit[] {
  const hits: PlaceHit[] = [];
  for (const alias of LANDMARKS) {
    const index = text.search(alias.re);
    if (index < 0) continue;
    const matched = text.slice(index).match(alias.re);
    hits.push({
      city: alias.city,
      english: alias.english,
      index,
      landmark: matched?.[0] ?? alias.landmark,
    });
  }
  hits.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  return hits.filter((hit) => {
    if (seen.has(hit.city)) return false;
    seen.add(hit.city);
    return true;
  });
}

function originName(text: string): string | null {
  const match = text.match(/从\s*([\u4e00-\u9fa5]{2,8})/);
  if (!match?.[1]) return null;
  const known = KNOWN_CITIES.find((city) => match[1].startsWith(city.name));
  return known?.name ?? null;
}

function cityAfterGoing(text: string): KnownCity | null {
  const match = text.match(/(?:去|到)\s*([\u4e00-\u9fa5]{2,8})/);
  if (!match?.[1]) return null;
  return KNOWN_CITIES.find((city) => match[1].startsWith(city.name)) ?? null;
}

/**
 * Turn a brief or a place string into a short geocoding query.
 * A West Lake sentence becomes 杭州, never the whole sentence.
 */
export function normalizeWeatherQuery(
  raw: string,
  alternateName?: string,
): { query: string; alternateName?: string } {
  const text = raw.trim();
  if (!text) return { query: "", alternateName };

  const going = cityAfterGoing(text);
  if (going) return { query: going.name, alternateName: alternateName || going.english };

  const landmarks = citiesInText(text);
  if (landmarks.length > 0) {
    const hit = landmarks[landmarks.length - 1]!;
    return { query: hit.city, alternateName: alternateName || hit.english };
  }

  const origin = originName(text);
  const mentioned = KNOWN_CITIES.filter((city) => text.includes(city.name) && city.name !== origin);
  if (mentioned.length > 0) {
    const preferred = cityAfterGoing(text);
    const hit = preferred && mentioned.some((city) => city.name === preferred.name) ? preferred : mentioned[0]!;
    return { query: hit.name, alternateName: alternateName || hit.english };
  }

  const sentence = text.length > 20 || /[，。！？；,.!?]/.test(text);
  if (sentence) {
    const going = text.match(/(?:去|到|在)\s*([\u4e00-\u9fa5]{2,8})/);
    const token = going?.[1];
    if (token && token !== text) return normalizeWeatherQuery(token, alternateName);
    return { query: "", alternateName };
  }

  return { query: text.slice(0, 40), alternateName };
}
