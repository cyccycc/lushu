import { undoLast } from "@lushu/agent/roadbook";
import { authorizedBook } from "@/lib/roadbook-http";
import { persistRoadbook } from "@/lib/roadbook-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const loaded = await authorizedBook(request, id);
  if ("error" in loaded) return Response.json({ error: loaded.error }, { status: loaded.status });
  const result = undoLast(loaded.stored.book);
  if (!result.ok) return Response.json({ error: result.error, book: loaded.stored.book }, { status: 400 });
  await persistRoadbook(loaded.stored, result.book);
  return Response.json({ book: result.book });
}
