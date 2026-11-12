import { applyPatch, planAnswer, planMessage } from "@lushu/agent/roadbook";
import { proposeModelPatch } from "@lushu/agent/roadbook-server";
import { authorizedBook } from "@/lib/roadbook-http";
import { llmEnvFromRequest, redactSecret } from "@/lib/llm-request";
import { persistRoadbook } from "@/lib/roadbook-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const loaded = await authorizedBook(request, id);
  if ("error" in loaded) return Response.json({ error: loaded.error }, { status: loaded.status });
  const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (text.length < 1) return Response.json({ error: "先写一句。" }, { status: 400 });
  if (text.length > 400) return Response.json({ error: "一句就够，请写在 400 字以内。" }, { status: 400 });

  const book = loaded.stored.book;
  const ruled = book.question ? planAnswer(book, text) : planMessage(book, text);
  if (ruled.request) {
    const result = applyPatch(book, ruled.request);
    if (!result.ok) return Response.json({ error: result.error, book }, { status: 400 });
    await persistRoadbook(loaded.stored, result.book);
    return Response.json({ book: result.book, note: ruled.note });
  }
  if (ruled.note) return Response.json({ error: ruled.note, book }, { status: 400 });

  const parsed = llmEnvFromRequest(request);
  if (!parsed.ok) {
    return Response.json(
      {
        error:
          parsed.error ?? "这句话需要模型。请在浏览器里填写密钥。密钥不会保存到服务器，也不会写进日志。",
      },
      { status: 400 },
    );
  }
  const env = parsed.env;
  try {
    const plan = await proposeModelPatch(book, text, env);
    if (!plan.request) return Response.json({ book, note: plan.note });
    const result = applyPatch(book, plan.request);
    if (!result.ok) return Response.json({ error: result.error, book }, { status: 400 });
    await persistRoadbook(loaded.stored, result.book);
    return Response.json({ book: result.book, note: plan.note });
  } catch (error) {
    const message = error instanceof Error ? error.message : "模型没有完成。";
    return Response.json({ error: redactSecret(message, env.apiKey) || "模型没有完成。" }, { status: 502 });
  }
}
