import { applyPlanFollowUp } from "@lushu/agent";
import { enqueueSave, isSessionId, readSession } from "@/lib/store";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isSessionId(id)) {
    return Response.json({ error: "找不到这趟行程。" }, { status: 404 });
  }
  const session = await readSession(id);
  if (!session?.result || session.status !== "ready" || !session.selectedVariantId) {
    return Response.json({ error: "先选定一套方案，再在这份行程上补充。" }, { status: 409 });
  }
  const body = (await request.json().catch(() => null)) as { prompt?: unknown } | null;
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length < 2) {
    return Response.json({ error: "写一句想改的地方。" }, { status: 400 });
  }
  if (prompt.length > 500) {
    return Response.json({ error: "补充请写在 500 字以内。" }, { status: 400 });
  }
  const index = session.result.variants.findIndex((item) => item.id === session.selectedVariantId);
  const current = session.result.variants[index];
  if (!current || index < 0) {
    return Response.json({ error: "没有这套方案。" }, { status: 400 });
  }
  const applied = applyPlanFollowUp(current, session.result.spec, prompt);
  const variants = session.result.variants.slice();
  variants[index] = applied.variant;
  session.result = { ...session.result, variants };
  session.followUps = [
    ...session.followUps,
    { at: new Date().toISOString(), prompt, summary: applied.summary },
  ].slice(-20);
  session.updatedAt = new Date().toISOString();
  await enqueueSave(session);
  return Response.json({ session, summary: applied.summary });
}
