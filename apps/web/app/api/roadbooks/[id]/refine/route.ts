import { applyPatch } from "@lushu/agent/roadbook";
import { proposeModelPatch } from "@lushu/agent/roadbook-server";
import { authorizedBook } from "@/lib/roadbook-http";
import { llmEnvFromRequest, redactSecret } from "@/lib/llm-request";
import { enqueueRoadbook } from "@/lib/roadbook-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const loaded = await authorizedBook(request, id);
  if ("error" in loaded) return Response.json({ error: loaded.error }, { status: loaded.status });
  const env = llmEnvFromRequest(request);
  if (!env) {
    return Response.json({ error: "浏览器里还没有模型密钥。" }, { status: 400 });
  }
  try {
    const plan = await proposeModelPatch(loaded.stored.book, null, env);
    if (!plan.request) return Response.json({ book: loaded.stored.book, note: plan.note });
    const result = applyPatch(loaded.stored.book, plan.request);
    if (!result.ok) return Response.json({ book: loaded.stored.book, note: result.error });
    await enqueueRoadbook({ accessKey: loaded.stored.accessKey, book: result.book });
    return Response.json({ book: result.book, note: plan.note });
  } catch (error) {
    const message = error instanceof Error ? error.message : "模型没有完成。";
    return Response.json({ error: redactSecret(message, env.apiKey) || "模型没有完成。", book: loaded.stored.book }, { status: 502 });
  }
}
