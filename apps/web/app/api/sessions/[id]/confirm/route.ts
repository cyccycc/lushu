import { denyIfClosed } from "@/lib/gate";
import { enqueueSave, isSessionId, readSession } from "@/lib/store";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await denyIfClosed();
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!isSessionId(id)) {
    return Response.json({ error: "找不到这趟行程。" }, { status: 404 });
  }
  const session = await readSession(id);
  if (!session?.result) {
    return Response.json({ error: "方案还没写好。" }, { status: 409 });
  }
  const body = (await request.json().catch(() => null)) as { variantId?: unknown } | null;
  const variantId = typeof body?.variantId === "string" ? body.variantId : "";
  const variant = session.result.variants.find((item) => item.id === variantId);
  if (!variant) {
    return Response.json({ error: "没有这套方案。" }, { status: 400 });
  }
  session.selectedVariantId = variant.id;
  session.status = "ready";
  session.updatedAt = new Date().toISOString();
  await enqueueSave(session);
  return Response.json({ session });
}
