import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { LogoutButton } from "@/components/logout-button";

export async function SiteHeader() {
  const user = await currentUser();
  return (
    <header className="no-print border-b border-border/80 bg-background/80 backdrop-blur-sm">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4">
        <Link href="/" className="flex items-center gap-3">
          <span
            aria-hidden
            className="grid h-10 w-10 place-items-center border-2 border-destructive font-serif text-lg leading-none text-destructive -rotate-6"
          >
            路
          </span>
          <span>
            <span className="block font-serif text-xl leading-none tracking-wide">路书</span>
            <span className="mt-1 block text-xs text-muted-foreground">个人旅行规划</span>
          </span>
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/mine" className="underline-offset-4 hover:underline">
            我的路书
          </Link>
          {user ? (
            <>
              <span className="hidden text-muted-foreground sm:inline">{user.email}</span>
              <LogoutButton />
            </>
          ) : (
            <Link href="/login" className="underline-offset-4 hover:underline">
              登录
            </Link>
          )}
          <p className="hidden text-right text-xs leading-5 text-muted-foreground sm:block">不预订 · 不收款</p>
        </nav>
      </div>
    </header>
  );
}
