import { applyRoadbookStyle, ROADBOOK_STYLES, type RoadbookStyle } from "@lushu/agent/roadbook";
import { authorizedBook } from "@/lib/roadbook-http";
import { persistRoadbook } from "@/lib/roadbook-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const loaded = await authorizedBook(request, id);
  if ("error" in loaded) return Response.json({ error: loaded.error }, { status: loaded.status });
  const body = (await request.json().catch(() => null)) as { style?: unknown; confirmed?: unknown } | null;
  const style = body?.style === "main" || (typeof body?.style === "string" && (ROADBOOK_STYLES as readonly string[]).includes(body.style))
    ? (body.style as RoadbookStyle | "main")
    : null;
  if (!style) return Response.json({ error: "没有这种风格。" }, { status: 400 });
  const result = applyRoadbookStyle(loaded.stored.book, style, body?.confirmed === true);
  if (!result.ok && result.confirm) return Response.json({ confirm: true, note: result.note, book: result.book });
  if (!result.ok) return Response.json({ error: result.error, book: result.book }, { status: 400 });
  await persistRoadbook(loaded.stored, result.book);
  return Response.json({ book: result.book });
}
