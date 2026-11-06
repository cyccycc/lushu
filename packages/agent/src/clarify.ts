import { parseBrief } from "./parse";

export const CONFIRMED_MARK = "【已确认假设】";

export type ClarifyChoice = {
  id: string;
  label: string;
};

export type ClarifyQuestion = {
  id: string;
  prompt: string;
  choices: ClarifyChoice[];
  assumedId: string;
  assumedLabel: string;
};

export type ClarifyAssessment = {
  needsClarify: boolean;
  questions: ClarifyQuestion[];
  assumptions: string[];
};

const WEEKDAY = "周[一二三四五六日天]";
const DAYPART = "上午|下午|晚上|中午|凌晨|傍晚";
const CLOCK_WORD = "\\d{1,2}|[零〇一二两三四五六七八九十]{1,3}";
const CLOCK_RE = new RegExp(
  `((?:${WEEKDAY}|明天|后天|今天|今晚)?\\s*(?:${DAYPART})?\\s*(?:${CLOCK_WORD})\\s*[点时](?:\\s*(?:\\d{1,2}|半|一刻|三刻))?|\\d{1,2}\\s*[:：]\\s*\\d{2})`,
);

const TRANSPORT_RE = /高铁|动车|火车|航班|飞机|客机|大巴|客车/;
const DEPART_RE = /出发|发车|起飞|离开/;
const ARRIVE_RE = /到达|抵达|到站|降落|(?:点|时)\s*到(?!为止)/;

function transportTimeQuestion(brief: string): ClarifyQuestion | null {
  if (!TRANSPORT_RE.test(brief) || DEPART_RE.test(brief) || ARRIVE_RE.test(brief)) return null;
  const match = brief.match(CLOCK_RE);
  const label = match?.[1]?.replace(/\s+/g, "");
  if (!label) return null;
  return {
    id: "transport-time",
    prompt: `「${label}」是出发，还是到达？`,
    choices: [
      { id: "depart", label: `按出发：${label} 发车或起飞` },
      { id: "arrive", label: `按到达：${label} 抵达目的地` },
    ],
    assumedId: "depart",
    assumedLabel: `时刻没写清是走还是到，默认按出发理解（${label}），不会当成到达。`,
  };
}

const HARD_RULES: { label: string; re: RegExp }[] = [
  { label: "体检", re: /体检/ },
  { label: "面试", re: /面试/ },
  { label: "会议", re: /开会|会议/ },
  { label: "就医", re: /看病|复诊/ },
];

function hardQuestion(brief: string): ClarifyQuestion | null {
  for (const rule of HARD_RULES) {
    if (!rule.re.test(brief)) continue;
    const windowed = new RegExp(
      `(?:上午|下午|晚上|中午|${CLOCK_WORD}\\s*[点时]).{0,12}(?:${rule.re.source})|(?:${rule.re.source}).{0,12}(?:上午|下午|晚上|中午|${CLOCK_WORD}\\s*[点时])`,
    );
    if (windowed.test(brief)) continue;
    return {
      id: "hard-slot",
      prompt: `「${rule.label}」放在哪一段？这段时间不排景点。`,
      choices: [
        { id: "morning", label: "出发当天上午" },
        { id: "afternoon", label: "出发当天下午" },
        { id: "next-day", label: "到达后的第二天" },
        { id: "off-day", label: "不占白天" },
      ],
      assumedId: "morning",
      assumedLabel: `「${rule.label}」没写钟点，默认放在出发当天上午，上午不排景点。`,
    };
  }
  return null;
}

function durationQuestion(): ClarifyQuestion {
  return {
    id: "duration",
    prompt: "这趟走几天？当天回来，还是住几晚？",
    choices: [
      { id: "daytrip", label: "当天往返" },
      { id: "2", label: "住 1 晚（2 天）" },
      { id: "3", label: "住 2 晚（3 天）" },
      { id: "4", label: "住 3 晚（4 天）" },
    ],
    assumedId: "3",
    assumedLabel: "没写天数，也没写是否当天回来，默认按 3 天（住 2 晚）。",
  };
}

function partyQuestion(): ClarifyQuestion {
  return {
    id: "party",
    prompt: "几个人一起？",
    choices: [
      { id: "1", label: "1 个人" },
      { id: "2", label: "2 个人" },
      { id: "3", label: "3 到 4 个人" },
      { id: "5", label: "5 个人或更多" },
    ],
    assumedId: "2",
    assumedLabel: "没写人数，默认按 2 个人估算。",
  };
}

export function assessClarification(brief: string): ClarifyAssessment {
  if (brief.includes(CONFIRMED_MARK)) {
    return { needsClarify: false, questions: [], assumptions: [] };
  }
  const spec = parseBrief(brief);
  const questions: ClarifyQuestion[] = [];
  const time = transportTimeQuestion(brief);
  if (time) questions.push(time);
  const hard = hardQuestion(brief);
  if (hard && questions.length < 3) questions.push(hard);
  if (spec.daysAssumed && questions.length < 3) questions.push(durationQuestion());
  if (spec.party.kind === "unknown" && questions.length < 3) questions.push(partyQuestion());

  const assumptions = questions.map((question) => question.assumedLabel);
  if (spec.daysAssumed && !questions.some((question) => question.id === "duration")) {
    assumptions.push("没写天数，默认按 3 天。");
  }
  if (spec.party.kind === "unknown" && !questions.some((question) => question.id === "party")) {
    assumptions.push("没写人数，默认按 2 个人估算。");
  }
  return {
    needsClarify: questions.length > 0,
    questions,
    assumptions,
  };
}

function pickedChoice(question: ClarifyQuestion, answers: Record<string, string>): ClarifyChoice {
  const id = answers[question.id] || question.assumedId;
  const found =
    question.choices.find((item) => item.id === id) ??
    question.choices.find((item) => item.id === question.assumedId) ??
    question.choices[0];
  if (!found) throw new Error("clarify question has no choices");
  return found;
}

function plannerHints(question: ClarifyQuestion, picked: ClarifyChoice): string[] {
  if (question.id === "transport-time") {
    return [
      picked.id === "arrive"
        ? "上述时刻按到达、抵达理解，不是出发。"
        : "上述时刻按出发、发车理解，不是到达。",
    ];
  }
  if (question.id === "duration") {
    const map: Record<string, string> = {
      daytrip: "当天往返，一共 1 天。",
      "2": "一共 2 天。",
      "3": "一共 3 天。",
      "4": "一共 4 天。",
    };
    return map[picked.id] ? [map[picked.id]] : [];
  }
  if (question.id === "party") {
    const map: Record<string, string> = {
      "1": "1 个人。",
      "2": "2 个人。",
      "3": "3 个人。",
      "5": "5 个人。",
    };
    return map[picked.id] ? [map[picked.id]] : [];
  }
  if (question.id === "hard-slot") {
    const label = question.prompt.match(/「(.+?)」/)?.[1] ?? "硬性安排";
    const map: Record<string, string> = {
      morning: `${label}在出发当天上午，上午不排景点。`,
      afternoon: `${label}在出发当天下午，下午不排景点。`,
      "next-day": `${label}在到达后的第二天，那天上午不排景点。`,
      "off-day": `${label}不占白天。`,
    };
    return [map[picked.id] ?? `${label}在出发当天上午，上午不排景点。`];
  }
  return [];
}

export function applyClarification(brief: string, answers: Record<string, string>): string {
  const source = (brief.split(CONFIRMED_MARK)[0] ?? brief).trim();
  const assessment = assessClarification(source);
  if (!assessment.needsClarify) return source;
  const spoken: string[] = [];
  const hints: string[] = [];
  for (const question of assessment.questions) {
    const picked = pickedChoice(question, answers);
    spoken.push(`${question.prompt} → ${picked.label}`);
    hints.push(...plannerHints(question, picked));
  }
  return `${source}\n${CONFIRMED_MARK}\n${spoken.join("\n")}\n${hints.join("\n")}`.trim();
}
