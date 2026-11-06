"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function ExportBar({ id, variantId }: { id: string; variantId: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const markdown = `/api/sessions/${id}/export?format=md&variant=${encodeURIComponent(variantId)}`;
  const json = `/api/sessions/${id}/export?format=json&variant=${encodeURIComponent(variantId)}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/i/${id}`);
      setCopied(true);
      setCopyError(null);
    } catch {
      setCopyError("浏览器没有允许复制，请手动复制地址栏。");
    }
  }

  return (
    <div className="no-print space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button type="button" className="rounded-full" onClick={() => void copyLink()}>
          {copied ? "链接已复制" : "复制分享链接"}
        </Button>
        <Button nativeButton={false} render={<a href={markdown} />} variant="outline" className="rounded-full">
          导出 Markdown
        </Button>
        <Button nativeButton={false} render={<a href={json} />} variant="outline" className="rounded-full">
          导出 JSON
        </Button>
      </div>
      {copyError ? <p className="text-sm text-destructive">{copyError}</p> : null}
    </div>
  );
}
