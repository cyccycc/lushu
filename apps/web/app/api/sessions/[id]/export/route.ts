import { itineraryToMarkdown } from "@lushu/agent";
import { denyIfClosed } from "@/lib/gate";
import { isSessionId, readSession } from "@/lib/store";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await denyIfClosed();
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!isSessionId(id)) {
    return Response.json({ error: "找不到这趟行程。" }, { status: 404 });
  }
  const session = await readSession(id);
  const variants = session?.result?.variants ?? [];
  const requested = new URL(request.url).searchParams.get("variant");
  const variant =
    variants.find((item) => item.id === (requested || session?.selectedVariantId)) ?? variants[0];
  if (!session || !variant) {
    return Response.json({ error: "还没有可以导出的行程。" }, { status: 404 });
  }
  const format = new URL(request.url).searchParams.get("format") === "json" ? "json" : "md";
  if (format === "json") {
    const body = JSON.stringify(
      {
        aiGenerated: true,
        brief: session.brief,
        modeNote: session.result?.modeNote,
        variant,
      },
      null,
      2,
    );
    return new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="lushu-${id}.json"`,
      },
    });
  }
  const markdown = itineraryToMarkdown(variant, {
    brief: session.brief,
    modeNote: session.result?.modeNote,
  });
  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="lushu-${id}.md"`,
    },
  });
}
