"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AgentStep, AgentUsage } from "@lushu/agent";
import { formatDayWeather, weatherHeaderText } from "@lushu/agent/text";
import { ClarifyForm } from "@/components/clarify-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { SessionRecord } from "@/lib/session-types";

const phaseLabel: Record<AgentStep["phase"], string> = {
  planning: "规划",
  searching: "检索",
  synthesizing: "整理",
  awaiting_confirm: "等待确认",
};

type SseEvent =
  | { type: "progress"; steps: AgentStep[]; usage: AgentUsage }
  | { type: "done"; session: SessionRecord }
  | { type: "error"; message: string };

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

async function readEvents(response: Response, onEvent: (event: SseEvent) => void) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((item) => item.startsWith("data:"));
      if (!line) continue;
      onEvent(JSON.parse(line.slice(5).trim()) as SseEvent);
    }
  }
}

export function PlanStudio({ id }: { id: string }) {
  const router = useRouter();
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async (): Promise<SessionRecord | null> => {
    const response = await fetch(`/api/sessions/${id}`, { cache: "no-store" });
    if (response.status === 404) {
      setMissing(true);
      return null;
    }
    const data = (await response.json()) as { session?: SessionRecord };
    if (!data.session) {
      setMissing(true);
      return null;
    }
    setSession(data.session);
    return data.session;
  }, [id]);

  const start = useCallback(async () => {
    setRunning(true);
    setError(null);
    setEditing(false);
    const response = await fetch(`/api/sessions/${id}/run`, { method: "POST" });
    if (response.status === 409) {
      const current = await load();
      if (current?.status === "running") {
        window.setTimeout(() => {
          void load();
        }, 900);
      }
      setRunning(false);
      return;
    }
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("application/json")) {
      const data = (await response.json()) as { session?: SessionRecord; error?: string };
      if (data.session) setSession(data.session);
      if (!response.ok) setError(data.error ?? "规划没有开始。");
      setRunning(false);
      return;
    }
    if (!response.ok) {
      setError("规划没有开始。");
      setRunning(false);
      return;
    }
    await readEvents(response, (event) => {
      if (event.type === "progress") {
        setSession((current) =>
          current
            ? { ...current, status: "running", steps: event.steps, usage: event.usage }
            : current,
        );
      } else if (event.type === "done") {
        setSession(event.session);
      } else {
        setError(event.message);
        setSession((current) =>
          current ? { ...current, status: "error", errorMessage: event.message } : current,
        );
      }
    });
    setRunning(false);
  }, [id, load]);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    void (async () => {
      const current = await load();
      if (stopped || !current) return;
      if (current.status === "draft" || current.status === "error") {
        await start();
      } else if (current.status === "running") {
        const poll = async () => {
          const next = await load();
          if (stopped || !next || next.status !== "running") {
            if (!stopped) setRunning(false);
            return;
          }
          timer = window.setTimeout(() => void poll(), 900);
        };
        setRunning(true);
        await poll();
      }
    })();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [id, load, start]);

  async function retry() {
    setSession((current) => (current ? { ...current, status: "error", result: null } : current));
    await start();
  }

  async function confirmAssumptions(answers: Record<string, string>) {
    setRunning(true);
    setError(null);
    setEditing(false);
    try {
      const response = await fetch(`/api/sessions/${id}/clarify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      const data = (await response.json()) as { session?: SessionRecord; error?: string };
      if (!response.ok || !data.session) {
        setError(data.error ?? "没有按这些假设重跑。");
        setRunning(false);
        return;
      }
      setSession(data.session);
      await start();
    } catch {
      setError("没有按这些假设重跑。");
      setRunning(false);
    }
  }

  async function choose(variantId: string) {
    setChoosing(variantId);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantId }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(data.error ?? "没有保存选择。");
        setChoosing(null);
        return;
      }
      router.push(`/i/${id}`);
    } catch {
      setError("没有保存选择。");
      setChoosing(null);
    }
  }

  if (missing) {
    return (
      <main className="mx-auto max-w-lg px-4 py-20">
        <h1 className="font-serif text-3xl">找不到这趟行程</h1>
        <p className="mt-3 text-muted-foreground">链接只对创建它的这台机器有效。</p>
        <Button nativeButton={false} render={<Link href="/" />} className="mt-6 rounded-full">
          回到首页
        </Button>
      </main>
    );
  }

  const steps = session?.steps ?? [];
  const usage = session?.usage;
  const variants = session?.result?.variants ?? [];

  return (
    <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-8 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs tracking-[0.16em] text-muted-foreground">步骤</p>
          <p className="mt-2 font-serif text-2xl">
            {usage ? `${usage.steps}/${usage.maxSteps}` : "—"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            估算 {usage ? money(usage.estimatedUsd) : "$0.00"}
            {usage ? ` / ${money(usage.maxCostUsd)}` : ""}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            工具 {usage ? `${usage.toolCalls}/${usage.maxToolCalls}` : "0"}
          </p>
        </div>
        <ol className="space-y-4" aria-live="polite">
          {steps.length === 0 ? (
            <li className="text-sm text-muted-foreground">正在读取这趟行程…</li>
          ) : (
            steps.map((step) => (
              <li key={step.id} className="grid grid-cols-[14px_1fr] gap-3">
                <span
                  className={`mt-1.5 h-2.5 w-2.5 rounded-full ${
                    step.status === "error"
                      ? "bg-destructive"
                      : step.status === "running"
                        ? "animate-pulse bg-primary"
                        : step.status === "skipped"
                          ? "bg-border"
                          : "bg-primary"
                  }`}
                />
                <div>
                  <p className="text-xs text-muted-foreground">{phaseLabel[step.phase]}</p>
                  <p className="text-sm font-medium">{step.title}</p>
                  <p className="text-sm leading-6 text-muted-foreground">{step.detail}</p>
                </div>
              </li>
            ))
          )}
        </ol>
      </aside>

      <section className="space-y-5">
        <div>
          <p className="text-sm text-muted-foreground">你的需求</p>
          <h1 className="mt-2 font-serif text-3xl leading-snug text-balance">{session?.brief ?? "…"}</h1>
          <Link href="/" className="mt-3 inline-block text-sm text-muted-foreground underline-offset-4 hover:underline">
            换一段需求
          </Link>
        </div>

        {session?.result?.modeNote ? (
          <p className="rounded-xl border border-border bg-card px-4 py-3 text-sm leading-6">
            {session.result.modeNote}
          </p>
        ) : null}
        {usage?.limitReached ? (
          <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
            {usage.limitReached}
          </p>
        ) : null}
        {error ? (
          <div className="flex flex-col gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm">{error}</p>
            <Button type="button" variant="outline" className="rounded-full" onClick={() => void retry()}>
              再试一次
            </Button>
          </div>
        ) : null}

        {session?.clarification?.confirmed && session.clarification.assumptions.length > 0 && !editing ? (
          <div className="rounded-xl border border-border bg-card px-4 py-3 text-sm leading-6">
            <p className="font-medium">这次采用的假设</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
              {session.clarification.assumptions.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <Button
              type="button"
              variant="outline"
              className="mt-3 rounded-full"
              disabled={running}
              onClick={() => setEditing(true)}
            >
              修改假设并重跑
            </Button>
          </div>
        ) : null}

        {!running &&
        session?.clarification &&
        session.clarification.questions.length > 0 &&
        (session.status === "needs_clarify" || editing) ? (
          <ClarifyForm
            questions={session.clarification.questions}
            assumptions={session.clarification.assumptions}
            pending={running}
            submitLabel={editing ? "按新的假设重跑" : "按这些假设规划"}
            onSubmit={(answers) => void confirmAssumptions(answers)}
          />
        ) : null}

        {running && session?.status === "running" && variants.length === 0 ? (
          <div className="grid gap-3 sm:grid-cols-2" aria-hidden>
            <div className="h-64 animate-pulse rounded-xl bg-muted" />
            <div className="h-64 animate-pulse rounded-xl bg-muted" />
          </div>
        ) : null}

        {variants.length > 0 && session?.status !== "needs_clarify" ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge>AI 生成</Badge>
              <p className="text-sm leading-6 text-muted-foreground">{session?.result?.contrast}</p>
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              {variants.map((variant) => {
                const selected = session?.selectedVariantId === variant.id;
                return (
                  <Card key={variant.id} className={selected ? "ring-2 ring-primary" : undefined}>
                    <CardHeader>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">{variant.style}</Badge>
                        <Badge variant="outline">AI 生成</Badge>
                      </div>
                      <CardTitle className="font-serif text-2xl leading-snug">{variant.title}</CardTitle>
                      <p className="text-sm font-medium leading-6">{weatherHeaderText(variant.days)}</p>
                      {variant.days.some((day) => day.weather?.available) ? (
                        <p className="text-xs leading-5 text-muted-foreground">
                          预报从查询当天起算，不一定是出发日。雨天备选仍写在每天的方案 B 里。
                        </p>
                      ) : null}
                      <p className="text-sm leading-6 text-muted-foreground">{variant.summary}</p>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-sm">{variant.pace}</p>
                      <p className="text-sm text-muted-foreground">{variant.suitability}</p>
                      <ol className="space-y-2 text-sm">
                        {variant.days.map((day) => (
                          <li key={day.day}>
                            <span className="font-medium">{formatDayWeather(day.weather, day.city)}</span>
                            <span className="mt-0.5 block text-muted-foreground">
                              第 {day.day} 天 · {day.title}
                            </span>
                          </li>
                        ))}
                      </ol>
                      <p className="text-sm leading-6 text-muted-foreground">{variant.budgetNote}</p>
                    </CardContent>
                    <CardFooter className="border-t">
                      {session?.status === "ready" && selected ? (
                        <Button
                          nativeButton={false}
                          render={<Link href={`/i/${id}`} />}
                          className="rounded-full"
                        >
                          打开行程页
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          className="rounded-full"
                          disabled={choosing != null || running}
                          onClick={() => void choose(variant.id)}
                        >
                          {choosing === variant.id ? "正在生成链接…" : "用这个方案"}
                        </Button>
                      )}
                    </CardFooter>
                  </Card>
                );
              })}
            </div>
          </>
        ) : null}
      </section>
    </main>
  );
}
