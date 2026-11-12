import { chatComplete, type LlmEnv } from "@lushu/llm";
import { extractJson } from "../json";
import { opsFromUnknown } from "./patch";
import type { Plan, Roadbook } from "./types";

/** One example of each op. update keeps the changed item fields inside `fields`. */
export const modelPatchExamples = {
  add: {
    op: "add",
    item: {
      id: "i_new",
      dayIndex: 1,
      startTime: "15:00",
      durationMinutes: 90,
      title: "书院门",
      place: "西安 · 碑林",
      lat: null,
      lng: null,
      type: "景点",
      status: "待做",
      source: { kind: "推断", note: "请出发前核实" },
      travelEstimateMinutes: 20,
      estimateSource: "推断",
      priority: "想去",
      indoor: false,
      note: "请出发前核实",
    },
  },
  update: {
    op: "update",
    id: "i1",
    fields: { title: "华清宫", place: "西安 · 临潼", note: "请出发前核实" },
  },
  remove: { op: "remove", id: "i2" },
  reorder: { op: "reorder", dayIndex: 1, ids: ["i1", "i_new"] },
} as const;

export const modelPatchSystem = `你是「路书」的修改器。使用者自己旅行，你只改结构化行程。
规则：
- 不代订、不收款，不写购票或支付步骤，不索要证件或银行卡。
- 只输出一个 JSON 对象：{"ops":[...]}。不要 Markdown。
- ops 只能是 add、update、remove、reorder。不要重写整份路书。
- update 必须把改动放进 fields，不要和 op、id 平铺。
- 不要修改已经锁定的项，不要输出 locked。
- 主景点在整本路书里只出现一次，除非使用者明确要再去一次。
- 不要替换优先级为「必去」的户外项。下雨时把它留在原处，并在 note 里写「是户外，下雨要不要去」。
- 不要编造 URL。不确定就在 note 里写「请出发前核实」。
- 时间用 24 小时制 HH:mm。类型只能是 交通、景点、餐、休息、自由、办事。优先级只能是 必去、想去、可砍。
- 不要删除、改写或顺延类型为「办事」的项。
四种补丁各举一例：
${JSON.stringify(modelPatchExamples.add)}
${JSON.stringify(modelPatchExamples.update)}
${JSON.stringify(modelPatchExamples.remove)}
${JSON.stringify(modelPatchExamples.reorder)}`;

function compact(book: Roadbook): string {
  return JSON.stringify({
    city: book.city,
    title: book.title,
    assumptions: book.assumptions.map((item) => ({ label: item.label, value: item.value, inferred: item.inferred })),
    items: book.items.map((item) => ({
      id: item.id,
      dayIndex: item.dayIndex,
      startTime: item.startTime,
      durationMinutes: item.durationMinutes,
      title: item.title,
      place: item.place,
      type: item.type,
      status: item.status,
      priority: item.priority,
      locked: item.locked,
      indoor: item.indoor,
    })),
  });
}

export async function proposeModelPatch(
  book: Roadbook,
  userText: string | null,
  env: LlmEnv,
): Promise<Plan> {
  const task = userText
    ? `使用者说：「${userText.slice(0, 400)}」。请用尽量少的补丁完成这句话。办不到就返回 {"ops":[]}。`
    : "请只做小修补：改清含糊标题、标出需要核实的 note。不要更换城市，不要增加一天，ops 不超过 4 条。";
  const result = await chatComplete({
    env,
    json: true,
    temperature: 0.2,
    messages: [
      { role: "system", content: modelPatchSystem },
      { role: "user", content: `${task}\n\n当前路书：\n${compact(book)}` },
    ],
  });
  const parsed = opsFromUnknown(extractJson(result.content));
  if ("error" in parsed) return { request: null, note: parsed.error };
  if (parsed.ops.length === 0) return { request: null, note: userText ? "模型没有改这一句。" : "模型觉得草稿不用改。" };
  const note = userText ? "已按你的句子打了补丁。" : "模型补了一小处，没有整份重写。";
  return {
    request: {
      label: userText ? "按句子修改" : "模型修补",
      kind: "model",
      ops: parsed.ops,
      statusNote: note,
    },
    note,
  };
}
