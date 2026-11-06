"use client";

import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="text-muted-foreground underline-offset-4 hover:underline"
      onClick={() => {
        void fetch("/api/auth/logout", { method: "POST" }).then(() => {
          router.push("/");
          router.refresh();
        });
      }}
    >
      退出
    </button>
  );
}
