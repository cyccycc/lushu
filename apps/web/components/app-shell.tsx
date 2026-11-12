"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function AppShell({ header, children }: { header: ReactNode; children: ReactNode }) {
  const path = usePathname();
  const bare = path === "/" || path.startsWith("/b/") || path.startsWith("/s/");
  return (
    <>
      {bare ? null : header}
      <div className={bare ? "min-h-dvh" : "flex flex-1 flex-col"}>{children}</div>
    </>
  );
}
