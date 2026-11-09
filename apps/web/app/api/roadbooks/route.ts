import { buildDraftFromSpec, forecastDaysThrough, normalizeWeatherQuery, replaceWeather, snapsFromReport, specForQuestion, specFromExtract, specFromRules } from "@lushu/agent/roadbook";
import { extractBrief, validateExtract, type TripExtract } from "@lushu/agent/roadbook-server";
import { getWeather, webSearch } from "@lushu/tools";
import { gateOpen, passwordConfigured } from "@/lib/gate";
import { llmEnvFromRequest } from "@/lib/llm-request";
import { createAccessKey, createRoadbookId, enqueueRoadbook, listRoadbooks } from "@/lib/roadbook-store";

const MODEL_STATUS = "已从你的原话读出时间和安排";
const RULES_STATUS = "没填模型密钥，按关键词粗读；填了能读懂时间和已定安排";
const FALLBACK_STATUS = "这句话没能按原话读全，已按关键词粗读。";

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
  const parsedEnv = llmEnvFromRequest(request);
  if (!parsedEnv.ok && parsedEnv.error) {
    return Response.json({ error: parsedEnv.error }, { status: 400 });
  }
  let spec = null as ReturnType<typeof specFromRules> | null;
  let via: "model" | "rules" = "rules";
  let extracted: TripExtract | null = null;
  if (parsedEnv.ok) {
    const ex = await extractBrief(brief, now, { ...parsedEnv.env, timeoutMs: 15_000 }).catch(() => null);
    const validated = ex ? validateExtract(ex, now, brief) : null;
    if (validated?.ok) {
      spec = specFromExtract(validated.value, now, validated.ask, brief);
      extracted = validated.value;
      via = "model";
    } else if (validated?.ask) {
      spec = specForQuestion(brief, validated.ask);
      via = "model";
    }
  }
  if (!spec) spec = specFromRules(brief, now);
  let book = buildDraftFromSpec(spec, { id: createRoadbookId(), now });
  book = {
    ...book,
    extract: extracted,
    statusLine:
      book.items.length === 0 && book.question
        ? book.statusLine
        : via === "model"
          ? MODEL_STATUS
          : parsedEnv.ok
            ? FALLBACK_STATUS
            : RULES_STATUS,
  };
  const days = book.items.reduce((max, item) => Math.max(max, item.dayIndex), 1);
  const searchText = spec.area ? `${book.city} ${spec.area} 开放时间` : `${book.city} 旅行 开放时间`;
  if (book.city !== "未写明的目的地") {
    const place = normalizeWeatherQuery(book.city);
    const [weather, search] = await Promise.all([
      getWeather(book.city, forecastDaysThrough(book.startDate, days, now), { alternateName: place.alternateName }).catch(() => null),
      webSearch(searchText).catch(() => null),
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
