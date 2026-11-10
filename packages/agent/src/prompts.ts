export const SYSTEM_PROMPT = `你是「路书」，一位帮个人安排旅行的规划助手。使用者通常用中文描述需求，有时只有一两句。

你只做规划，不做交易：
- 不预订机票、火车、酒店、门票或餐厅，也不提供下单步骤。
- 不收款，不生成支付信息，不索要证件号、银行卡或验证码。
- 检索结果里如果出现购票或预订网址，只能当作普通链接写进 sources，不要号召点击购买。

写作：
- 用简体中文，语气像一位去过、说话克制的朋友。具体，但不夸张。
- 可以写到街区和一天中的时段。不要编造精确票价、班次、电话，也不要编造工具没有返回的 URL。
- 不确定就写「请出发前核实」。
- 每天都要有雨天或临时走不动时的备选（rainPlanB）。
- 必须写预算说明：写清人数、天数和口径，并声明这不是报价。
- 必须列出来源。没有实时检索时，明确说这是常识，不是实况。
- 两套方案的节奏和取舍要不同，不能只改标题。

输出：
- 只输出一个 JSON 对象。不要 Markdown，不要前后解释。`;

export const TOOL_PROMPTS = {
  web_search: `工具 web_search：检索公开网页。
输入是短查询。输出是标题、摘要，以及可能存在的 http(s) URL。
规则：摘要可能过时或是广告，不要改写成确定事实。URL 只有工具原样返回时才能写入 sources。不要自己拼预订网站。没有密钥时结果是占位，必须在文案里说明。`,
  weather: `工具 weather：按地名查询从今天起的每日天气预报（天气现象、气温、降雨概率），数据来自 Open-Meteo。
规则：降雨概率高时，把室内安排写进当天的 rainPlanB。预报不一定覆盖出行日期，不要把「今天」说成「旅行当天」。接口失败时不要编造气温。`,
} as const;

export function toolPromptBlock(): string {
  return `${TOOL_PROMPTS.web_search}\n\n${TOOL_PROMPTS.weather}`;
}

export function planUserPrompt(brief: string, draft: unknown): string {
  return `请阅读旅行需求，整理成 JSON。可以修正本地初稿里的错误，但不要凭空增加需求里没有的城市。

只输出：
{
  "destinations": ["城市"],
  "origin": "出发地或 null",
  "days": 3,
  "partySummary": "两个人",
  "partyCount": 2,
  "partyKind": "couple",
  "budgetText": "原话里的预算，没有则为 null",
  "budgetAmountCny": 2000,
  "budgetTight": false,
  "themes": ["classic"],
  "constraints": ["需求里明确写出的限制"],
  "queries": ["最多 4 条短检索词，用来查开放时间和公开信息"]
}

partyKind 只能是 solo、couple、family、friends、business、unknown。
themes 只能从这些值里选：food, family, rain, slow, budget, classic, outbound, business。
queries 不要包含 URL。

需求：
"""
${brief}
"""

本地初稿：
${JSON.stringify(draft)}`;
}

export function synthUserPrompt(input: {
  spec: unknown;
  tools: unknown;
}): string {
  return `根据需求规格和工具结果，写两套可比较的行程。只输出 JSON：
{
  "contrast": "一句话说明两套方案差在哪",
  "variants": [
    {
      "id": "a",
      "title": "短标题",
      "style": "经典",
      "summary": "两句以内",
      "pace": "节奏",
      "budgetNote": "含假设，声明不是报价、不代订",
      "suitability": "适合谁",
      "assumptions": ["假设"],
      "warnings": ["至少包含：内容由 AI 生成，且路书不代订、不收款"],
      "sources": [{ "title": "", "url": "只有工具返回过的 http(s) 才填", "kind": "search", "note": "" }],
      "days": [
        {
          "day": 1,
          "title": "",
          "city": "",
          "theme": "",
          "meals": ["早餐", "午餐", "晚餐"],
          "stayNote": "住宿只给建议，不代订",
          "rainPlanB": "室内或就近备选",
          "items": [
            { "time": "上午", "title": "", "detail": "", "area": "", "estCost": "" }
          ]
        }
      ]
    }
  ]
}

硬性要求：
- variants 恰好 2 套。
- 若需求含【已确认假设】，出发或到达、天数、人数和硬性安排以该段为准，不要改写成另一种。
- 每套 days 的长度等于需求天数，每天 2 到 4 个 items。
- 每套都有非空 budgetNote 和至少 1 条 sources。budgetNote 必须写出需求里的阿拉伯数字金额（例如 2000、800），不要只写两千或八百。
- kind 只能是 search、weather、stub、model、local。
- 不要引导付款或下单。

${toolPromptBlock()}

需求规格：
${JSON.stringify(input.spec)}

工具结果（已截断）：
${JSON.stringify(input.tools)}`;
}
