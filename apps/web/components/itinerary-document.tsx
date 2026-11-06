import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { formatDayWeather, weatherHeaderText } from "@lushu/agent/text";
import { ExportBar } from "@/components/export-bar";
import { FollowUpBar } from "@/components/follow-up-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { readSession } from "@/lib/store";

export async function ItineraryDocument({ id }: { id: string }) {
  await connection();
  const session = await readSession(id);
  if (!session) notFound();
  const variant =
    session.result?.variants.find((item) => item.id === session.selectedVariantId) ??
    session.result?.variants[0];

  if (!variant || session.status !== "ready") {
    return (
      <main className="mx-auto flex max-w-lg flex-col gap-4 px-4 py-20">
        <h1 className="font-serif text-3xl">这页还不能分享</h1>
        <p className="leading-7 text-muted-foreground">
          先在方案页选定一套。选定之后，这里才是只读行程。
        </p>
        <Button nativeButton={false} render={<Link href={`/plan/${id}`} />} className="w-fit rounded-full">
          回到方案
        </Button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 pb-36 sm:py-12">
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm leading-6">
        <strong className="font-medium">AI 生成，仅供参考。</strong>
        这不是订单。路书不预订机票、火车、酒店或门票，也不向使用者收款。开放时间、票价和天气请出发前核实。
      </div>

      <header className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Badge>{variant.style}</Badge>
          <Badge variant="outline">AI 生成</Badge>
          <Badge variant="secondary">{variant.days.length} 天</Badge>
        </div>
        <h1 className="font-serif text-4xl leading-tight text-balance">{variant.title}</h1>
        <p className="text-base font-medium leading-7">{weatherHeaderText(variant.days)}</p>
        {variant.days.some((day) => day.weather?.available) ? (
          <p className="text-sm leading-6 text-muted-foreground">
            预报从查询当天起算，不一定是出发日。每天开头是当天的城市、日期、天气、气温和降水概率。
          </p>
        ) : (
          <p className="text-sm leading-6 text-muted-foreground">天气没有显示成数字时，就是这次没拿到预报。</p>
        )}
        <p className="text-lg leading-8">{variant.summary}</p>
        <p className="text-sm leading-6 text-muted-foreground">{variant.suitability}</p>
        {session.result?.modeNote ? (
          <p className="text-sm leading-6 text-muted-foreground">{session.result.modeNote}</p>
        ) : null}
        <ExportBar id={id} variantId={variant.id} />
      </header>

      <section className="rounded-xl border border-border bg-card px-4 py-4">
        <h2 className="font-serif text-xl">预算说明</h2>
        <p className="mt-2 text-sm leading-7">{variant.budgetNote}</p>
      </section>

      <div className="space-y-8">
        {variant.days.map((day) => (
          <article key={day.day} className="grid gap-4 border-t border-border pt-6 sm:grid-cols-[4.5rem_1fr]">
            <p className="font-serif text-4xl leading-none text-primary">{day.day}</p>
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium leading-6">{formatDayWeather(day.weather, day.city)}</p>
                <h2 className="mt-1 font-serif text-2xl">{day.title}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {day.city} · {day.theme}
                </p>
              </div>
              <ol className="space-y-4">
                {day.items.map((item) => (
                  <li key={`${day.day}-${item.time}-${item.title}`}>
                    <p className="text-xs tracking-wide text-muted-foreground">{item.time}</p>
                    <p className="font-medium">
                      {item.title}
                      {item.area ? <span className="font-normal text-muted-foreground"> · {item.area}</span> : null}
                    </p>
                    <p className="text-sm leading-7">{item.detail}</p>
                    {item.estCost ? <p className="text-xs text-muted-foreground">{item.estCost}</p> : null}
                  </li>
                ))}
              </ol>
              <p className="rounded-lg bg-muted px-3 py-2 text-sm leading-6">
                <span className="font-medium">雨天或走不动：</span>
                {day.rainPlanB}
              </p>
              {day.meals.length > 0 ? (
                <p className="text-sm leading-6">
                  <span className="text-muted-foreground">吃 · </span>
                  {day.meals.join(" / ")}
                </p>
              ) : null}
              <p className="text-sm leading-6 text-muted-foreground">{day.stayNote}</p>
            </div>
          </article>
        ))}
      </div>

      {variant.supplements && variant.supplements.length > 0 ? (
        <section className="space-y-4">
          <h2 className="font-serif text-xl">补充</h2>
          {variant.supplements.map((extra) => (
            <article key={extra.id} className="rounded-xl border border-border bg-card px-4 py-4">
              <h3 className="font-medium">{extra.title}</h3>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-7">{extra.body}</p>
            </article>
          ))}
        </section>
      ) : null}

      <section className="space-y-2">
        <h2 className="font-serif text-xl">假设</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm leading-6">
          {variant.assumptions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="font-serif text-xl">请注意</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm leading-6">
          {variant.warnings.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="font-serif text-xl">来源</h2>
        <ul className="space-y-3 text-sm leading-6">
          {variant.sources.map((source) => (
            <li key={`${source.kind}-${source.title}`}>
              <span className="text-muted-foreground">{source.kind} · </span>
              {source.url ? (
                <a href={source.url} className="underline underline-offset-4" rel="noreferrer noopener">
                  {source.title}
                </a>
              ) : (
                source.title
              )}
              {source.note ? <span className="text-muted-foreground"> — {source.note}</span> : null}
            </li>
          ))}
        </ul>
      </section>

      <p className="text-xs leading-6 text-muted-foreground">
        原来的需求：{session.brief}
      </p>
      <FollowUpBar id={id} />
    </main>
  );
}
