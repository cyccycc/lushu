"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { examples } from "@/lib/examples";

export function IntakeForm() {
  const router = useRouter();
  const [brief, setBrief] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(text: string) {
    const next = text.trim();
    if (next.length < 2) {
      setError("先写一句去哪儿、几天。");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: next }),
      });
      const data = (await response.json()) as { session?: { id: string }; error?: string };
      if (!response.ok || !data.session) {
        setError(data.error ?? "没有创建成功，请再试一次。");
        setPending(false);
        return;
      }
      router.push(`/plan/${data.session.id}`);
    } catch {
      setError("网络没有连上，请再试一次。");
      setPending(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(brief);
      }}
    >
      <label htmlFor="brief" className="block font-serif text-lg">
        这趟想怎么走？
      </label>
      <Textarea
        id="brief"
        name="brief"
        value={brief}
        maxLength={2000}
        placeholder="例如：下周末两个人从上海去苏州，预算两千，想看园林，也想吃本地菜。"
        className="min-h-36 bg-card text-base leading-7"
        onChange={(event) => setBrief(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit(brief);
          }
        }}
      />
      <div className="flex flex-wrap gap-2">
        {examples.map((example) => (
          <button
            key={example.label}
            type="button"
            className="rounded-full"
            onClick={() => {
              setBrief(example.brief);
              setError(null);
            }}
          >
            <Badge variant="outline" className="h-7 cursor-pointer px-3 text-sm">
              {example.label}
            </Badge>
          </button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">短一点也行。Ctrl 或 ⌘ 加回车可以直接开始。</p>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">内容由 AI 生成。路书不下单，也不向你收费。</p>
        <Button type="submit" size="lg" className="h-11 rounded-full px-6" disabled={pending}>
          {pending ? "正在打开…" : "开始规划"}
        </Button>
      </div>
    </form>
  );
}
