import { setChecklistChecked } from "@lushu/agent/roadbook";
import { authorizedBook } from "@/lib/roadbook-http";
import { persistRoadbook } from "@/lib/roadbook-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const loaded = await authorizedBook(request, id);
  if ("error" in loaded) return Response.json({ error: loaded.error }, { status: loaded.status });
  const body = (await request.json().catch(() => null)) as { id?: unknown; checked?: unknown } | null;
  const rowId = typeof body?.id === "string" ? body.id.trim() : "";
  if (!rowId || typeof body?.checked !== "boolean") {
    return Response.json({ error: "核实项无法解析。" }, { status: 400 });
  }
  const result = setChecklistChecked(loaded.stored.book, rowId, body.checked);
  if (!result.ok) return Response.json({ error: result.error, book: result.book }, { status: 400 });
  await persistRoadbook(loaded.stored, result.book);
  return Response.json({ book: result.book });
}
