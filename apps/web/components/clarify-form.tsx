"use client";

import { useState } from "react";
import type { ClarifyQuestion } from "@lushu/agent";
import { Button } from "@/components/ui/button";

export function ClarifyForm({
  questions,
  assumptions,
  pending,
  submitLabel,
  onSubmit,
}: {
  questions: ClarifyQuestion[];
  assumptions: string[];
  pending: boolean;
  submitLabel?: string;
  onSubmit: (answers: Record<string, string>) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});

  function selected(question: ClarifyQuestion): string {
    return answers[question.id] ?? question.assumedId;
  }

  return (
    <form
      className="space-y-5 rounded-xl border border-border bg-card p-4 sm:p-5"
      onSubmit={(event) => {
        event.preventDefault();
        const next: Record<string, string> = {};
        for (const question of questions) next[question.id] = selected(question);
        onSubmit(next);
      }}
    >
      <div className="space-y-2">
        <h2 className="font-serif text-2xl">先确认几件事</h2>
        <p className="text-sm leading-6 text-muted-foreground">
          这几处还不清楚，先问完再写两套方案。带「默认」的选项是不改也会采用的假设。时刻不会被悄悄当成到达。
        </p>
      </div>
      {assumptions.length > 0 ? (
        <div className="rounded-lg bg-muted px-3 py-3 text-sm leading-6">
          <p className="font-medium">当前默认</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {assumptions.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {questions.map((question) => (
        <fieldset key={question.id} className="space-y-2">
          <legend className="text-sm font-medium">{question.prompt}</legend>
          <div className="flex flex-wrap gap-2">
            {question.choices.map((choice) => {
              const on = selected(question) === choice.id;
              return (
                <button
                  key={choice.id}
                  type="button"
                  aria-pressed={on}
                  className={`rounded-full border px-3 py-1.5 text-sm ${
                    on ? "border-primary bg-primary/10" : "border-border bg-background"
                  }`}
                  onClick={() => setAnswers((current) => ({ ...current, [question.id]: choice.id }))}
                >
                  {choice.label}
                  {choice.id === question.assumedId ? "（默认）" : ""}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}
      <Button type="submit" size="lg" className="h-11 rounded-full px-6" disabled={pending}>
        {pending ? "正在按这些假设规划…" : (submitLabel ?? "按这些假设规划")}
      </Button>
    </form>
  );
}
