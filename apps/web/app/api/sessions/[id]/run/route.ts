import { AgentInputError, assessClarification, runTravelAgent } from "@lushu/agent";
import { clearActive, enqueueSave, isActive, isSessionId, markActive, readSession } from "@/lib/store";
import type { SessionRecord } from "@/lib/session-types";

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isSessionId(id)) {
    return Response.json({ error: "找不到这趟行程。" }, { status: 404 });
  }
  if (isActive(id)) {
    return Response.json({ error: "正在规划。" }, { status: 409 });
  }
  markActive(id);

  const existing = await readSession(id);
  if (!existing) {
    clearActive(id);
    return Response.json({ error: "找不到这趟行程。" }, { status: 404 });
  }
  if (existing.status === "awaiting_confirm" || existing.status === "ready") {
    clearActive(id);
    return Response.json({ session: existing, already: true });
  }
  if (!existing.clarification?.confirmed) {
    const assessment = assessClarification(existing.brief);
    if (assessment.needsClarify) {
      existing.status = "needs_clarify";
      existing.clarification = {
        questions: assessment.questions,
        assumptions: assessment.assumptions,
        answers: existing.clarification?.answers ?? null,
        confirmed: false,
      };
      existing.updatedAt = new Date().toISOString();
      await enqueueSave(existing);
      clearActive(id);
      return Response.json({ session: existing, needsClarify: true });
    }
  }
  const briefForPlan =
    existing.clarification?.confirmed && existing.planningBrief ? existing.planningBrief : existing.brief;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // The browser went away. Keep planning and save the file.
        }
      };
      const session: SessionRecord = {
        ...existing,
        status: "running",
        errorMessage: null,
        updatedAt: new Date().toISOString(),
      };
      await enqueueSave(session);
      try {
        const result = await runTravelAgent(briefForPlan, {
          onStep: ({ steps, usage }) => {
            session.steps = steps;
            session.usage = usage;
            session.updatedAt = new Date().toISOString();
            void enqueueSave(session);
            send({ type: "progress", steps, usage });
          },
        });
        session.result = result;
        session.steps = result.steps;
        session.usage = result.usage;
        session.status = "awaiting_confirm";
        session.updatedAt = new Date().toISOString();
        await enqueueSave(session);
        send({ type: "done", session });
      } catch (error) {
        session.status = "error";
        session.errorMessage =
          error instanceof AgentInputError ? error.message : "规划没有完成，请再试一次。";
        session.updatedAt = new Date().toISOString();
        await enqueueSave(session);
        send({ type: "error", message: session.errorMessage });
      } finally {
        clearActive(id);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
