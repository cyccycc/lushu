import { authorizedBook } from "@/lib/roadbook-http";
import { ensureShareKey } from "@/lib/roadbook-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const loaded = await authorizedBook(request, id);
  if ("error" in loaded) return Response.json({ error: loaded.error }, { status: loaded.status });
  const stored = await ensureShareKey(loaded.stored);
  return Response.json({ book: stored.book, shareKey: stored.shareKey });
}
