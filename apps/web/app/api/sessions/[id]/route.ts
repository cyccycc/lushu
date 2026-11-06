import { clearActive, enqueueSave, isActive, isSessionId, readSession } from "@/lib/store";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isSessionId(id)) {
    return Response.json({ error: "找不到这趟行程。" }, { status: 404 });
  }
  const session = await readSession(id);
  if (!session) {
    return Response.json({ error: "找不到这趟行程。" }, { status: 404 });
  }
  if (session.status === "running" && !isActive(id)) {
    const age = Date.now() - new Date(session.updatedAt).getTime();
    if (age > 20_000) {
      session.status = "error";
      session.errorMessage = "规划中断了，请再试一次。";
      session.updatedAt = new Date().toISOString();
      clearActive(id);
      await enqueueSave(session);
    }
  }
  return Response.json({ session });
}
