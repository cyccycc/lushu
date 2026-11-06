import type { PatchRequest } from "@lushu/agent/roadbook";
import { canReadBook } from "./gate";
import { isRoadbookId, readRoadbook, type StoredRoadbook } from "./roadbook-store";

export async function authorizedBook(
  request: Request,
  id: string,
): Promise<{ stored: StoredRoadbook } | { error: string; status: number }> {
  if (!isRoadbookId(id)) return { error: "找不到这本路书。", status: 404 };
  const stored = await readRoadbook(id);
  if (!stored) return { error: "找不到这本路书。", status: 404 };
  if (!(await canReadBook(request, stored.accessKey))) {
    return { error: "需要访问密码或私密链接。", status: 401 };
  }
  return { stored };
}

const KINDS = new Set(["draft", "user", "late", "rain", "tired", "assumption", "model"]);

export function readPatchBody(body: unknown): PatchRequest | string {
  if (!body || typeof body !== "object") return "补丁无法解析。";
  const raw = body as Partial<PatchRequest> & { setQuestion?: unknown };
  if (typeof raw.label !== "string" || !Array.isArray(raw.ops)) return "补丁无法解析。";
  if (typeof raw.kind !== "string" || !KINDS.has(raw.kind)) return "补丁类型无效。";
  let setQuestion: PatchRequest["setQuestion"];
  if (raw.setQuestion === null) setQuestion = null;
  else if (raw.setQuestion && typeof raw.setQuestion === "object") {
    const question = raw.setQuestion as { id?: unknown; prompt?: unknown };
    if (typeof question.prompt !== "string") return "追问无法解析。";
    setQuestion = {
      id: typeof question.id === "string" ? question.id.slice(0, 40) : "q",
      prompt: question.prompt.slice(0, 80),
    };
  }
  const startDate =
    typeof raw.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.startDate) ? raw.startDate : undefined;
  return {
    id: typeof raw.id === "string" ? raw.id.slice(0, 40) : undefined,
    label: raw.label.slice(0, 80),
    kind: raw.kind,
    ops: raw.ops,
    assumptions: raw.assumptions,
    verifyAdds: Array.isArray(raw.verifyAdds)
      ? raw.verifyAdds.filter((item): item is string => typeof item === "string").slice(0, 6)
      : undefined,
    setQuestion,
    title: typeof raw.title === "string" ? raw.title : undefined,
    city: typeof raw.city === "string" ? raw.city : undefined,
    startDate,
    statusNote: typeof raw.statusNote === "string" ? raw.statusNote : undefined,
  };
}
