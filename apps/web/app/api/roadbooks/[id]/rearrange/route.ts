import {
  applyPatch,
  forecastDaysThrough,
  normalizeWeatherQuery,
  planRain,
  planTired,
  replaceWeather,
  snapsFromReport,
} from "@lushu/agent/roadbook";
import { getWeather } from "@lushu/tools";
import { authorizedBook } from "@/lib/roadbook-http";
import { enqueueRoadbook } from "@/lib/roadbook-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const loaded = await authorizedBook(request, id);
  if ("error" in loaded) return Response.json({ error: loaded.error }, { status: loaded.status });
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  const action = body?.action === "rain" || body?.action === "tired" ? body.action : null;
  if (!action) return Response.json({ error: "只接受下雨了或累了。晚了 1 小时在浏览器里计算。" }, { status: 400 });

  let book = loaded.stored.book;
  if (book.city !== "未写明的目的地") {
    const days = book.items.reduce((max, item) => Math.max(max, item.dayIndex), 1);
    const place = normalizeWeatherQuery(book.city);
    try {
      const report = await getWeather(book.city, forecastDaysThrough(book.startDate, days), {
        alternateName: place.alternateName,
      });
      book = replaceWeather(book, snapsFromReport(report, book.city, new Date().toISOString()));
    } catch {
      // Keep the cached forecast and still apply the rule.
    }
  }
  const plan = action === "rain" ? planRain(book) : planTired(book);
  if (!plan.request) {
    await enqueueRoadbook({ accessKey: loaded.stored.accessKey, book });
    return Response.json({ book, note: plan.note });
  }
  const result = applyPatch(book, plan.request);
  if (!result.ok) return Response.json({ error: result.error, book: loaded.stored.book }, { status: 400 });
  await enqueueRoadbook({ accessKey: loaded.stored.accessKey, book: result.book });
  return Response.json({ book: result.book, note: plan.note });
}
