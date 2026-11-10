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
  { re: /西湖|灵隐|雷峰塔|断桥|河坊街|白堤|苏堤|龙井|湖边/, city: "杭州", english: "Hangzhou", landmark: "西湖" },
  { re: /外滩|豫园|武康路|陆家嘴/, city: "上海", english: "Shanghai", landmark: "外滩" },
  { re: /故宫|颐和园|天坛|什刹海/, city: "北京", english: "Beijing", landmark: "故宫" },
  { re: /兵马俑|大雁塔/, city: "西安", english: "Xi'an", landmark: "兵马俑" },
  { re: /宽窄巷子|锦里|武侯祠/, city: "成都", english: "Chengdu", landmark: "宽窄巷子" },
  { re: /拙政园|平江路|虎丘|山塘街/, city: "苏州", english: "Suzhou", landmark: "拙政园" },
  { re: /栈桥|八大关/, city: "青岛", english: "Qingdao", landmark: "栈桥" },
  { re: /洱海|崇圣寺/, city: "大理", english: "Dali", landmark: "洱海" },
  { re: /夫子庙|中山陵|玄武湖/, city: "南京", english: "Nanjing", landmark: "夫子庙" },
  { re: /鼓浪屿|曾厝垵/, city: "厦门", english: "Xiamen", landmark: "鼓浪屿" },
  { re: /泰山|岱庙/, city: "泰安", english: "Tai'an", landmark: "泰山" },
  { re: /黄山/, city: "黄山", english: "Huangshan", landmark: "黄山" },
  { re: /峨眉山|乐山大佛/, city: "乐山", english: "Leshan", landmark: "峨眉山" },
  { re: /华山/, city: "渭南", english: "Weinan", landmark: "华山" },
  { re: /九寨沟/, city: "阿坝", english: "Aba", landmark: "九寨沟" },
  { re: /漓江|阳朔/, city: "桂林", english: "Guilin", landmark: "漓江" },
  { re: /张家界|武陵源/, city: "张家界", english: "Zhangjiajie", landmark: "张家界" },
  { re: /瘦西湖/, city: "扬州", english: "Yangzhou", landmark: "瘦西湖" },
  { re: /黄鹤楼/, city: "武汉", english: "Wuhan", landmark: "黄鹤楼" },
  { re: /洪崖洞|磁器口|解放碑/, city: "重庆", english: "Chongqing", landmark: "洪崖洞" },
  { re: /长城|八达岭/, city: "北京", english: "Beijing", landmark: "长城" },
  { re: /乌镇|西塘/, city: "嘉兴", english: "Jiaxing", landmark: "乌镇" },
  { re: /都江堰|青城山/, city: "成都", english: "Chengdu", landmark: "都江堰" },
  { re: /莫高窟/, city: "敦煌", english: "Dunhuang", landmark: "莫高窟" },
  { re: /布达拉宫/, city: "拉萨", english: "Lhasa", landmark: "布达拉宫" },
  { re: /亚龙湾|天涯海角/, city: "三亚", english: "Sanya", landmark: "亚龙湾" },
  { re: /庐山/, city: "九江", english: "Jiujiang", landmark: "庐山" },
  { re: /普陀山/, city: "舟山", english: "Zhoushan", landmark: "普陀山" },
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
  { name: "泰安", english: "Tai'an" },
  { name: "重庆", english: "Chongqing" },
  { name: "桂林", english: "Guilin" },
  { name: "黄山", english: "Huangshan" },
  { name: "三亚", english: "Sanya" },
  { name: "扬州", english: "Yangzhou" },
  { name: "乐山", english: "Leshan" },
  { name: "张家界", english: "Zhangjiajie" },
  { name: "天津", english: "Tianjin" },
  { name: "沈阳", english: "Shenyang" },
  { name: "大连", english: "Dalian" },
  { name: "长春", english: "Changchun" },
  { name: "哈尔滨", english: "Harbin" },
  { name: "石家庄", english: "Shijiazhuang" },
  { name: "太原", english: "Taiyuan" },
  { name: "呼和浩特", english: "Hohhot" },
  { name: "合肥", english: "Hefei" },
  { name: "福州", english: "Fuzhou" },
  { name: "南昌", english: "Nanchang" },
  { name: "郑州", english: "Zhengzhou" },
  { name: "长沙", english: "Changsha" },
  { name: "南宁", english: "Nanning" },
  { name: "海口", english: "Haikou" },
  { name: "贵阳", english: "Guiyang" },
  { name: "兰州", english: "Lanzhou" },
  { name: "西宁", english: "Xining" },
  { name: "银川", english: "Yinchuan" },
  { name: "乌鲁木齐", english: "Urumqi" },
  { name: "拉萨", english: "Lhasa" },
  { name: "香港", english: "Hong Kong" },
  { name: "澳门", english: "Macau" },
  { name: "台北", english: "Taipei" },
  { name: "宁波", english: "Ningbo" },
  { name: "无锡", english: "Wuxi" },
  { name: "珠海", english: "Zhuhai" },
  { name: "洛阳", english: "Luoyang" },
  { name: "敦煌", english: "Dunhuang" },
  { name: "嘉兴", english: "Jiaxing" },
  { name: "舟山", english: "Zhoushan" },
  { name: "九江", english: "Jiujiang" },
  { name: "渭南", english: "Weinan" },
  { name: "阿坝", english: "Aba" },
];

const CITIES_BY_LENGTH = [...KNOWN_CITIES].sort((a, b) => b.name.length - a.name.length);

export type RouteHit = {
  from: string;
  to: string;
};

const RIDE_WORDS = /坐飞机|坐高铁|坐动车|坐火车|乘飞机|乘高铁|乘动车|乘火车|开车|自驾/g;

/** A clipped destination that is a phrase, not a place. Known city names are kept. */
export function isVaguePlaceName(raw: string): boolean {
  const token = raw.trim();
  if (!token) return true;
  if (KNOWN_CITIES.some((city) => city.name === token)) return false;
  return /个|的地方|哪里|哪儿|哪座|什么地方/.test(token);
}

/** 「从 A 去往 B」. B does not have to be in the city table. */
export function matchTravelRoute(text: string): RouteHit | null {
  const cleaned = text.replace(RIDE_WORDS, "");
  const match = cleaned.match(
    /从\s*([\u4e00-\u9fa5]{2,10}?)\s*(?:去往|前往|飞往|飞到|去|到|飞)\s*([\u4e00-\u9fa5]{2,8})/,
  );
  if (!match?.[1] || !match[2]) return null;
  return { from: match[1], to: match[2] };
}

export function cityByName(name: string): KnownCity | null {
  return KNOWN_CITIES.find((city) => city.name === name) ?? null;
}

export function longestCityPrefix(token: string): string | null {
  const found = CITIES_BY_LENGTH.find((city) => token.startsWith(city.name));
  return found?.name ?? null;
}

const PLACE_TAIL = /(?:玩玩|逛逛|走走|旅游|旅行|两天|三天|四天|五天|一天|几天|周末|周边|附近|那边|这里|一下|玩|逛|市)$/;

function stripPlaceTail(token: string): string {
  let next = token;
  for (let i = 0; i < 4; i += 1) {
    const stripped = next.replace(PLACE_TAIL, "");
    if (stripped === next) break;
    next = stripped;
  }
  return next;
}

/**
 * Turn a short phrase into a city name.
 * Known cities and landmarks win. Anything else is kept as written, so 济南 does not have to be templated.
 */
export function resolvePlaceToken(raw: string): string | null {
  const compact = raw.trim().replace(/\s+/g, "");
  if (!compact) return null;
  const prefixed = longestCityPrefix(compact);
  if (prefixed) return prefixed;
  if (isVaguePlaceName(compact)) return null;
  const token = stripPlaceTail(compact);
  if (!token || token.length < 2) return null;
  if (isVaguePlaceName(token)) return null;
  if (/^(看看|一下|哪儿|哪里|那里|这边|那边|这里|明天|后天|今天|周末|周边|附近|出发|返回|返程)$/.test(token)) {
    return null;
  }
  const known = longestCityPrefix(token);
  if (known) return known;
  const landmark = citiesInText(token)[0];
  if (landmark) return landmark.city;
  return token.slice(0, 12);
}

export function mentionedCities(text: string): { name: string; english: string; index: number }[] {
  const hits: { name: string; english: string; index: number; end: number }[] = [];
  for (const city of CITIES_BY_LENGTH) {
    let from = 0;
    while (from < text.length) {
      const index = text.indexOf(city.name, from);
      if (index < 0) break;
      const end = index + city.name.length;
      const overlaps = hits.some((hit) => index < hit.end && end > hit.index);
      if (!overlaps) hits.push({ name: city.name, english: city.english, index, end });
      from = end;
    }
  }
  hits.sort((a, b) => a.index - b.index);
  return hits.map(({ name, english, index }) => ({ name, english, index }));
}

export function citiesInText(text: string): PlaceHit[] {
  const hits: PlaceHit[] = [];
  for (const alias of LANDMARKS) {
    const index = text.search(alias.re);
    if (index < 0) continue;
    const matched = text.slice(index).match(alias.re);
    const matchedText = matched?.[0] ?? alias.landmark;
    hits.push({
      city: alias.city,
      english: alias.english,
      index,
      landmark: matchedText === "湖边" ? alias.landmark : matchedText,
    });
  }
  hits.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const shoreOnly = text.includes("湖边") && !/西湖|灵隐|雷峰塔|断桥|河坊街|白堤|苏堤|龙井/.test(text);
  const otherCity = shoreOnly && mentionedCities(text).some((city) => city.name !== "杭州");
  return hits.filter((hit) => {
    if (otherCity && hit.city === "杭州" && hit.landmark === "西湖") return false;
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

  const route = matchTravelRoute(text);
  if (route) {
    const city = resolvePlaceToken(route.to);
    if (city) {
      const known = cityByName(city);
      return { query: city, alternateName: alternateName || known?.english };
    }
  }

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
