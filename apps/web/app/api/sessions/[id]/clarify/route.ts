import { applyClarification, assessClarification } from "@lushu/agent";
import { enqueueSave, isActive, isSessionId, readSession } from "@/lib/store";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isSessionId(id)) {
    return Response.json({ error: "找不到这趟行程。" }, { status: 404 });
  }
  if (isActive(id)) {
    return Response.json({ error: "正在规划，请稍等。" }, { status: 409 });
  }
  const session = await readSession(id);
  if (!session) {
    return Response.json({ error: "找不到这趟行程。" }, { status: 404 });
  }
  const assessment = assessClarification(session.brief);
  if (!assessment.needsClarify) {
    return Response.json({ error: "这段需求不用再确认。" }, { status: 409 });
  }
  const body = (await request.json().catch(() => null)) as { answers?: unknown } | null;
  const answers: Record<string, string> = {};
  if (body?.answers && typeof body.answers === "object") {
    for (const [key, value] of Object.entries(body.answers)) {
      if (typeof value === "string" && key.length < 40 && value.length < 40) answers[key] = value;
    }
  }
  session.planningBrief = applyClarification(session.brief, answers);
  session.clarification = {
    questions: assessment.questions,
    assumptions: assessment.assumptions,
    answers,
    confirmed: true,
  };
  session.result = null;
  session.selectedVariantId = null;
  session.steps = [];
  session.usage = null;
  session.followUps = [];
  session.errorMessage = null;
  session.status = "draft";
  session.updatedAt = new Date().toISOString();
  await enqueueSave(session);
  return Response.json({ session });
}
