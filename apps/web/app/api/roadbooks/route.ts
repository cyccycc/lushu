import { buildDraft, forecastDaysThrough, normalizeWeatherQuery, replaceWeather, snapsFromReport } from "@lushu/agent/roadbook";
import { getWeather, webSearch } from "@lushu/tools";
import { gateOpen, passwordConfigured } from "@/lib/gate";
import { createAccessKey, createRoadbookId, enqueueRoadbook, listRoadbooks } from "@/lib/roadbook-store";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!passwordConfigured()) {
    return Response.json({
      books: [],
      passwordRequired: false,
      listLocked: true,
    });
  }
  if (!(await gateOpen())) {
    return Response.json({ error: "先输入访问密码。", books: [] }, { status: 401 });
  }
  const stored = await listRoadbooks();
  return Response.json({
    passwordRequired: true,
    listLocked: false,
    books: stored.map((item) => ({
      id: item.book.id,
      accessKey: item.accessKey,
      title: item.book.title,
      brief: item.book.brief,
      updatedAt: item.book.updatedAt,
      city: item.book.city,
    })),
  });
}

export async function POST(request: Request) {
  if (passwordConfigured() && !(await gateOpen())) {
    return Response.json({ error: "先输入访问密码。" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { brief?: unknown } | null;
  const brief = typeof body?.brief === "string" ? body.brief.trim() : "";
  if (brief.length < 2) return Response.json({ error: "先写一句去哪儿。" }, { status: 400 });
  if (brief.length > 2000) return Response.json({ error: "请写在 2000 字以内。" }, { status: 400 });

  const now = new Date();
  let book = buildDraft(brief, { id: createRoadbookId(), now });
  const days = book.items.reduce((max, item) => Math.max(max, item.dayIndex), 1);
  if (book.city !== "未写明的目的地") {
    const place = normalizeWeatherQuery(book.city);
    const [weather, search] = await Promise.all([
      getWeather(book.city, forecastDaysThrough(book.startDate, days, now), { alternateName: place.alternateName }).catch(() => null),
      webSearch(`${book.city} 旅行 开放时间`).catch(() => null),
    ]);
    book = replaceWeather(book, snapsFromReport(weather, book.city, now.toISOString()), now);
    const hit = search && !search.stub ? search.results.find((item) => item.url) : undefined;
    if (hit?.url) {
      book = {
        ...book,
        items: book.items.map((item, index) =>
          index === book.items.findIndex((entry) => entry.type === "景点")
            ? {
                ...item,
                source: {
                  kind: "检索" as const,
                  url: hit.url ?? undefined,
                  fetchedAt: now.toISOString(),
                  note: hit.title,
                },
              }
            : item,
        ),
      };
    }
  } else {
    book = replaceWeather(book, snapsFromReport(null, book.city, now.toISOString()), now);
  }

  const accessKey = createAccessKey();
  await enqueueRoadbook({ accessKey, book });
  return Response.json({ book, accessKey });
}
