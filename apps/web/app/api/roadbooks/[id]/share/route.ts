import { shareView } from "@lushu/agent/roadbook";
import { authorizedBook, sharedBook } from "@/lib/roadbook-http";
import { resetShareKey } from "@/lib/roadbook-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const loaded = await sharedBook(request, id);
  if ("error" in loaded) return Response.json({ error: loaded.error }, { status: loaded.status });
  return Response.json({ itinerary: shareView(loaded.stored.book) });
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const loaded = await authorizedBook(request, id);
  if ("error" in loaded) return Response.json({ error: loaded.error }, { status: loaded.status });
  const stored = await resetShareKey(loaded.stored);
  return Response.json({ shareKey: stored.shareKey });
}
