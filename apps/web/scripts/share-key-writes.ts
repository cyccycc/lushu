/**
 * Offline check: every book write keeps the stored shareKey.
 * Run from the repo root: pnpm exec tsx --tsconfig apps/web/tsconfig.json apps/web/scripts/share-key-writes.ts
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDraft } from "@lushu/agent/roadbook";
import { POST as checklistPost } from "@/app/api/roadbooks/[id]/checklist/route";
import { GET as ownerGet } from "@/app/api/roadbooks/[id]/route";
import { POST as messagePost } from "@/app/api/roadbooks/[id]/message/route";
import { POST as patchPost } from "@/app/api/roadbooks/[id]/patch/route";
import { POST as rearrangePost } from "@/app/api/roadbooks/[id]/rearrange/route";
import { POST as refinePost } from "@/app/api/roadbooks/[id]/refine/route";
import { GET as shareGet } from "@/app/api/roadbooks/[id]/share/route";
import { POST as stylePost } from "@/app/api/roadbooks/[id]/style/route";
import { POST as undoPost } from "@/app/api/roadbooks/[id]/undo/route";
import { createAccessKey, createRoadbookId, enqueueRoadbook, readRoadbook } from "@/lib/roadbook-store";

const routeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../app/api/roadbooks/[id]");

type Route = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function ownerRequest(id: string, accessKey: string, body: unknown): Request {
  return new Request(`http://127.0.0.1/api/roadbooks/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-lushu-book-key": accessKey },
    body: JSON.stringify(body),
  });
}

async function assertStable(id: string, accessKey: string, shareKey: string, label: string): Promise<string | null> {
  const stored = await readRoadbook(id);
  if (stored?.shareKey !== shareKey) return `${label} 之后磁盘上的 shareKey 变了`;
  const opened = await ownerGet(
    new Request(`http://127.0.0.1/api/roadbooks/${id}`, { headers: { "x-lushu-book-key": accessKey } }),
    ctx(id),
  );
  const ownerBody = (await opened.json()) as { shareKey?: string };
  if (!opened.ok || ownerBody.shareKey !== shareKey) return `${label} 之后机主再次打开换成了新的分享链接`;
  const shared = await shareGet(
    new Request(`http://127.0.0.1/api/roadbooks/${id}/share`, { headers: { "x-lushu-share-key": shareKey } }),
    ctx(id),
  );
  if (!shared.ok) return `${label} 之后分享链接失效（${shared.status}）`;
  return null;
}

async function write(
  route: Route,
  id: string,
  accessKey: string,
  shareKey: string,
  label: string,
  body: unknown,
  expectOk = true,
): Promise<string | null> {
  const response = await route(ownerRequest(id, accessKey, body), ctx(id));
  if (expectOk && !response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    return `${label} 没有写上：${response.status} ${payload?.error ?? ""}`;
  }
  return assertStable(id, accessKey, shareKey, label);
}

async function main(): Promise<string | null> {
  const dir = await mkdtemp(path.join(tmpdir(), "lushu-share-"));
  process.env.LUSHU_ROADBOOK_DIR = dir;
  try {
  const id = createRoadbookId();
  const accessKey = createAccessKey();
  const shareKey = "share-key-stable-0726";
  const now = new Date();
  let n = 0;
  const book = buildDraft("下周末两个人从上海去苏州，想看园林。", { id, now, random: () => `s${(n += 1)}` });
  book.city = "未写明的目的地";
  await enqueueRoadbook({ accessKey, shareKey, book });
  const saved = await assertStable(id, accessKey, shareKey, "保存");
  if (saved) return saved;

  const editable = book.items.find((item) => !item.locked && item.type !== "交通");
  const removable = book.items.find((item) => item.type === "自由" && !item.locked);
  const row = book.verifyChecklist[0];
  if (!editable || !removable || !row) return "分享键用例缺少可改项、可删项或清单";

  const writes: Array<[string, Route, unknown, boolean?]> = [
    [
      "patch",
      patchPost,
      {
        id: "p_share_note",
        label: "改备注",
        kind: "user",
        ops: [{ op: "update", id: editable.id, fields: { note: "分享键应还在" } }],
      },
    ],
    ["message", messagePost, { text: `删除${removable.title}` }],
    ["checklist", checklistPost, { id: row.id, checked: true }],
    ["undo", undoPost, {}],
    ["style", stylePost, { style: "更轻松", confirmed: true }],
    ["rearrange", rearrangePost, { action: "tired" }],
    ["refine", refinePost, {}, false],
  ];
  for (const [label, route, body, expectOk] of writes) {
    const problem = await write(route, id, accessKey, shareKey, label, body, expectOk !== false);
    if (problem) return problem;
  }

  for (const name of ["patch", "message", "rearrange", "checklist", "refine", "undo", "style"]) {
    const source = await readFile(path.join(routeDir, name, "route.ts"), "utf8");
    if (!source.includes("persistRoadbook(loaded.stored")) return `${name} 写接口没有保住整份存储`;
    if (source.includes("enqueueRoadbook({ accessKey")) return `${name} 仍只写入 accessKey 和 book`;
  }
  return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main()
  .then((problem) => {
    if (problem) {
      console.error(problem);
      process.exit(1);
    }
    console.log("ok");
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "share-key eval failed");
    process.exit(1);
  });
