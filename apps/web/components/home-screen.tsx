"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { KeySettings } from "@/components/key-settings";
import { llmRequestHeaders, readRecent, recentReplacement, rememberBook, replaceRecent, type RecentBook } from "@/lib/browser-book";

type Listed = RecentBook & { brief?: string };

/** Successful GET /api/roadbooks. Failed and unauthorized responses return null and do not touch lushu.recent. */
async function pullAuthoritativeRecent(): Promise<{ listLocked: boolean; books: Listed[] | null } | null> {
  const listed = await fetch("/api/roadbooks", { cache: "no-store" }).catch(() => null);
  if (!listed?.ok) return null;
  const data = (await listed.json().catch(() => null)) as { books?: Listed[]; listLocked?: boolean } | null;
  if (!data) return null;
  const books = recentReplacement(data);
  if (books !== null) replaceRecent(books);
  return { listLocked: Boolean(data.listLocked), books };
}

export function HomeScreen() {
  const router = useRouter();
  const [brief, setBrief] = useState("这周末想去西湖走走，两个人");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [required, setRequired] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [accessReady, setAccessReady] = useState(false);
  const [password, setPassword] = useState("");
  const [recent, setRecent] = useState<Listed[]>([]);
  const [listLocked, setListLocked] = useState(true);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const local = readRecent();
      if (!cancel) setRecent(local);
      const access = await fetch("/api/access", { cache: "no-store" }).then((res) => res.json());
      if (cancel) return;
      setRequired(Boolean(access.required));
      setUnlocked(Boolean(access.ok));
      if (access.required && access.ok) {
        const synced = await pullAuthoritativeRecent();
        if (cancel || !synced) return;
        setListLocked(synced.listLocked);
        if (synced.books !== null) setRecent(synced.books);
      } else {
        setListLocked(!access.required);
      }
    })().catch(() => undefined).finally(() => {
      if (!cancel) setAccessReady(true);
    });
    return () => {
      cancel = true;
    };
  }, []);

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNote("");
    const res = await fetch("/api/access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setNote(data?.error || "密码不对。");
      return;
    }
    setPassword("");
    setUnlocked(true);
    const synced = await pullAuthoritativeRecent();
    if (!synced) return;
    setListLocked(synced.listLocked);
    if (synced.books !== null) setRecent(synced.books);
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNote("正在读你的这句话…");
    const res = await fetch("/api/roadbooks", {
      method: "POST",
      headers: llmRequestHeaders(),
      body: JSON.stringify({ brief }),
    });
    const data = (await res.json().catch(() => null)) as { error?: string; book?: { id: string; title: string; updatedAt: string }; accessKey?: string } | null;
    setBusy(false);
    if (!res.ok || !data?.book || !data.accessKey) {
      setNote(data?.error || "草稿没有生成。");
      return;
    }
    rememberBook({
      id: data.book.id,
      accessKey: data.accessKey,
      title: data.book.title,
      updatedAt: data.book.updatedAt,
    });
    router.push(`/b/${data.book.id}/${data.accessKey}`);
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col gap-5 px-4 py-6">
      <header className="space-y-2">
        <p className="font-serif text-4xl">路书</p>
        <p className="text-sm leading-6 text-muted-foreground">
          一句就出可改的草稿。缺的信息标在假设上。不代订，不收款。
        </p>
      </header>

      {!accessReady ? (
        <p className="text-sm text-muted-foreground">正在打开…</p>
      ) : required && !unlocked ? (
        <form onSubmit={unlock} className="space-y-3 rounded-2xl border border-border bg-card p-4">
          <p className="text-sm">这台路书设了访问密码。输入后才能新建，也能在手机上看到同一份列表。</p>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            className="w-full rounded-xl border border-input bg-background px-3 py-3 text-base"
            placeholder="访问密码"
          />
          <button type="submit" disabled={busy} className="w-full rounded-xl bg-primary py-3 text-sm text-primary-foreground">
            进入
          </button>
        </form>
      ) : (
        <form onSubmit={create} className="space-y-3">
          <textarea
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            rows={4}
            className="w-full resize-none rounded-2xl border border-input bg-card px-3 py-3 text-base leading-6"
            placeholder="这周末想去西湖走走，两个人"
          />
          <button type="submit" disabled={busy} className="w-full rounded-xl bg-primary py-3 text-sm text-primary-foreground">
            {busy ? "正在读你的这句话…" : "生成草稿"}
          </button>
        </form>
      )}

      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      <KeySettings />

      <section className="space-y-2">
        <h2 className="text-sm font-medium">最近的路书</h2>
        {listLocked ? (
          <p className="text-xs leading-5 text-muted-foreground">
            没设访问密码时，服务器不公开列表。用私密链接在手机打开同一份。部署到别人能访问的地址前，请设置 ACCESS_PASSWORD。
          </p>
        ) : null}
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有。</p>
        ) : (
          <ul className="space-y-2">
            {recent.map((item) => (
              <li key={item.id}>
                <Link href={`/b/${item.id}/${item.accessKey}`} className="block rounded-2xl border border-border bg-card px-3 py-3">
                  <span className="block text-sm font-medium">{item.title}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{item.brief || "私密链接"}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-auto text-xs leading-5 text-muted-foreground">
        以前的双方案记录还在 <Link href="/mine" className="underline">我的路书</Link>。新的行程用这一页。
      </p>
    </main>
  );
}
