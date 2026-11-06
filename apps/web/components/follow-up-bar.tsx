"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function FollowUpBar({ id }: { id: string }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  async function submit() {
    const text = prompt.trim();
    if (text.length < 2) {
      setError("写一句想补充的，比如找酒店、打车路线，或改某一天的时间。");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${id}/follow-up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text }),
      });
      const data = (await response.json()) as { error?: string; summary?: string };
      if (!response.ok) {
        setError(data.error ?? "没有写进这份行程。");
        setPending(false);
        return;
      }
      setPrompt("");
      setSummary(data.summary ?? "已写进这份行程。");
      router.refresh();
    } catch {
      setError("网络没有连上。");
    }
    setPending(false);
  }

  return (
    <form
      className="no-print fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 px-4 py-3 backdrop-blur"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        <label htmlFor="follow-up" className="text-sm font-medium">
          接着改这趟
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="follow-up"
            value={prompt}
            maxLength={500}
            placeholder="找酒店、打车路线、把第2天改到下午。只补充建议，不预订。"
            className="h-11 flex-1 rounded-full border border-border bg-card px-4 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            onChange={(event) => setPrompt(event.target.value)}
          />
          <Button type="submit" className="h-11 rounded-full px-5" disabled={pending}>
            {pending ? "正在写进行程…" : "补充到这份行程"}
          </Button>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {summary && !error ? <p className="text-sm text-muted-foreground">{summary}</p> : null}
      </div>
    </form>
  );
}
