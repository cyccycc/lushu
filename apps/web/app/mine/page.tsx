import Link from "next/link";
import { connection } from "next/server";
import { currentUser } from "@/lib/auth";
import { listSessions } from "@/lib/store";
import type { SessionStatus } from "@/lib/session-types";
import { Button } from "@/components/ui/button";

const statusLabel: Record<SessionStatus, string> = {
  draft: "还没开始",
  needs_clarify: "等你确认",
  running: "规划中",
  awaiting_confirm: "等你选方案",
  ready: "可以阅读",
  error: "没有完成",
};

export default async function MinePage() {
  await connection();
  const [sessions, user] = await Promise.all([listSessions(), currentUser()]);
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
      <div className="space-y-2">
        <h1 className="font-serif text-4xl">我的路书</h1>
        <p className="text-sm leading-6 text-muted-foreground">
          这些记录在这台机器上。
          {user ? ` 当前邮箱是 ${user.email}。之后新建的路书会记在这个邮箱下。` : " 还没登录。登录只用邮箱验证码。"}
        </p>
      </div>
      {sessions.length === 0 ? (
        <div className="rounded-xl border border-border bg-card px-4 py-6">
          <p>还没有行程。</p>
          <Button nativeButton={false} render={<Link href="/" />} className="mt-4 rounded-full">
            去写一段需求
          </Button>
        </div>
      ) : (
        <ul className="space-y-3">
          {sessions.map((session) => (
            <li key={session.id} className="rounded-xl border border-border bg-card px-4 py-4">
              <p className="text-xs text-muted-foreground">
                {statusLabel[session.status]}
                {session.ownerEmail ? ` · ${session.ownerEmail}` : " · 本机"}
              </p>
              <h2 className="mt-1 font-serif text-2xl leading-snug">{session.title ?? "还没有标题"}</h2>
              <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">{session.brief}</p>
              <div className="mt-3 flex flex-wrap gap-3 text-sm">
                <Link href={`/plan/${session.id}`} className="underline underline-offset-4">
                  继续编辑
                </Link>
                {session.status === "ready" ? (
                  <Link href={`/i/${session.id}`} className="underline underline-offset-4">
                    只读行程
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
