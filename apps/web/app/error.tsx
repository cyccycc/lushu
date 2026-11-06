"use client";

import { Button } from "@/components/ui/button";

export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto flex max-w-lg flex-col gap-4 px-4 py-20">
      <h1 className="font-serif text-3xl">这一页没有打开</h1>
      <p className="text-muted-foreground">可以再试一次。如果还是不行，回到首页重新写一段需求。</p>
      <Button type="button" className="w-fit rounded-full" onClick={() => reset()}>
        再试一次
      </Button>
    </main>
  );
}
