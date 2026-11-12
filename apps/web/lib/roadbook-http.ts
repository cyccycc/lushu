import { classifyBookKey, type PatchRequest } from "@lushu/agent/roadbook";
import { bookKeyFrom, gateOpen, keyMatches } from "./gate";
import { isRoadbookId, readRoadbook, type StoredRoadbook } from "./roadbook-store";

export function shareKeyFrom(request: Request): string {
  const header = request.headers.get("x-lushu-share-key")?.trim() ?? "";
  if (header) return header;
  return bookKeyFrom(request);
}

/** Owner write. A share key is refused even when it is sent as the book key or with the access-password cookie. */
export async function authorizedBook(
  request: Request,
  id: string,
): Promise<{ stored: StoredRoadbook } | { error: string; status: number }> {
  if (!isRoadbookId(id)) return { error: "找不到这本路书。", status: 404 };
  const stored = await readRoadbook(id);
  if (!stored) return { error: "找不到这本路书。", status: 404 };
  const kind = classifyBookKey(bookKeyFrom(request), stored.accessKey, stored.shareKey);
  if (kind === "share") return { error: "分享链接只能看。", status: 403 };
  if (kind !== "owner" && !(await gateOpen())) {
    return { error: "需要访问密码或私密链接。", status: 401 };
  }
  return { stored };
}

/** Companion read. Only the share key works. The owner access key is not accepted here. */
export async function sharedBook(
  request: Request,
  id: string,
): Promise<{ stored: StoredRoadbook } | { error: string; status: number }> {
  if (!isRoadbookId(id)) return { error: "找不到这本路书。", status: 404 };
  const stored = await readRoadbook(id);
  if (!stored?.shareKey) return { error: "找不到这本路书。", status: 404 };
  if (!keyMatches(shareKeyFrom(request), stored.shareKey)) {
    return { error: "找不到这本路书。", status: 404 };
  }
  return { stored };
}

const KINDS = new Set(["draft", "user", "late", "rain", "tired", "assumption", "model", "style"]);

function readVerifyAdds(value: unknown): PatchRequest["verifyAdds"] {
  if (!Array.isArray(value)) return undefined;
  const adds: NonNullable<PatchRequest["verifyAdds"]> = [];
  for (const item of value) {
    if (adds.length >= 6) break;
    if (typeof item === "string") {
      adds.push(item);
      continue;
    }
    if (!item || typeof item !== "object" || typeof (item as { text?: unknown }).text !== "string") continue;
    const text = (item as { text: string }).text;
    const itemId = (item as { itemId?: unknown }).itemId;
    adds.push(typeof itemId === "string" ? { text, itemId } : { text });
  }
  return adds;
}

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
    verifyAdds: readVerifyAdds(raw.verifyAdds),
    setQuestion,
    title: typeof raw.title === "string" ? raw.title : undefined,
    city: typeof raw.city === "string" ? raw.city : undefined,
    startDate,
    statusNote: typeof raw.statusNote === "string" ? raw.statusNote : undefined,
  };
}
