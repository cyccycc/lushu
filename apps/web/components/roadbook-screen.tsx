"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  applyPatch,
  formatTime,
  parseTime,
  planAnswer,
  planAssumptionEdit,
  planLate,
  planMessage,
  snapForTripDay,
  undoLast,
  type PatchRequest,
  type Roadbook,
  type RoadbookItem,
} from "@lushu/agent/roadbook";
import { KeySettings } from "@/components/key-settings";
import {
  bookHeaders,
  hasBrowserKey,
  newPatchId,
  readCachedBook,
  readPending,
  rememberBook,
  writeCachedBook,
  writePending,
} from "@/lib/browser-book";

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function span(item: RoadbookItem): string {
  const start = parseTime(item.startTime);
  if (start == null) return item.startTime;
  return `${item.startTime}–${formatTime(Math.min(start + item.durationMinutes, 23 * 60 + 59))}`;
}

function weatherText(book: Roadbook): string {
  const days = [...new Set(book.items.map((item) => item.dayIndex))].sort((a, b) => a - b);
  const lines = days
    .map((day) => {
      const snap = snapForTripDay(book, day);
      if (!snap?.available) return null;
      return `第${day}天 ${snap.date ?? ""} ${snap.condition} ${snap.tempMinC ?? "?"}–${snap.tempMaxC ?? "?"}°C`;
    })
    .filter((line): line is string => Boolean(line));
  if (lines.length === 0) return book.weather[0]?.note || "天气还没缓存";
  return lines.join(" · ");
}

function changeSummary(changed: string[], removed: string[], days: string | undefined, dayRewrite: boolean): string {
  const body = [changed.length > 0 ? `改了 ${changed.length} 项` : "", removed.length > 0 ? `拿掉 ${removed.length} 项` : ""]
    .filter(Boolean)
    .join("，");
  if (dayRewrite && days) return `已按 ${days}重排：${body}`;
  return body;
}

function ChangeHint({
  highlighted,
  dropped,
  days,
  dayRewrite,
  open,
  onToggle,
}: {
  highlighted: string[];
  dropped: string[];
  days: string | undefined;
  dayRewrite: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const detail = [
    highlighted.length > 0 ? `刚改：${highlighted.join("、")}` : "",
    dropped.length > 0 ? `刚拿掉：${dropped.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("。");
  const collapsed = highlighted.length + dropped.length > 5;
  if (!collapsed) {
    return (
      <p data-changed="1" className="rounded-xl border border-amber-300 bg-amber-100/80 px-3 py-2 text-xs leading-5 text-amber-950">
        {detail}
      </p>
    );
  }
  return (
    <div data-changed="1" className="rounded-xl border border-amber-300 bg-amber-100/80 px-3 py-2 text-xs leading-5 text-amber-950">
      <button type="button" className="text-left" aria-expanded={open} onClick={onToggle}>
        {changeSummary(highlighted, dropped, days, dayRewrite)}
        <span className="ml-2 underline">{open ? "收起" : "展开"}</span>
      </button>
      {open ? <p className="mt-1">{detail}</p> : null}
    </div>
  );
}

export function RoadbookScreen({ id, accessKey }: { id: string; accessKey: string }) {
  const [book, setBook] = useState<Roadbook | null>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [online, setOnline] = useState(true);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [copied, setCopied] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [composerError, setComposerError] = useState("");
  const [changesOpen, setChangesOpen] = useState(false);
  const bookRef = useRef<Roadbook | null>(null);
  const editingRef = useRef<string | null>(null);
  const bookPane = useRef<HTMLDivElement>(null);
  const talkPane = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bookRef.current = book;
  }, [book]);

  useEffect(() => {
    const pane = bookPane.current;
    const changed = pane?.querySelector("[data-changed='1']");
    if (pane && changed instanceof HTMLElement) {
      const delta = changed.getBoundingClientRect().top - pane.getBoundingClientRect().top;
      pane.scrollTop += delta - 12;
    }
    if (talkPane.current) talkPane.current.scrollTop = talkPane.current.scrollHeight;
  }, [book?.updatedAt]);

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    const frame = requestAnimationFrame(() => {
      sync();
      setHasKey(hasBrowserKey());
    });
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  const flush = useCallback(async (base: Roadbook) => {
    let guard = 0;
    let latest = base;
    let applied = false;
    while (guard < 8) {
      guard += 1;
      const queue = readPending(id);
      const next = queue[0];
      if (!next) break;
      const res = await fetch(`/api/roadbooks/${id}/patch`, {
        method: "POST",
        headers: bookHeaders(accessKey),
        body: JSON.stringify(next),
      }).catch(() => null);
      if (!res || !res.ok) {
        setNote("有一条离线改动还没同步。");
        return;
      }
      const data = (await res.json()) as { book: Roadbook };
      latest = data.book;
      applied = true;
      writePending(id, readPending(id).filter((item) => item.id !== next.id));
    }
    if (!applied) return;
    setBook(latest);
    writeCachedBook(latest);
    rememberBook({ id, accessKey, title: latest.title, updatedAt: latest.updatedAt });
    setNote("离线改动已同步。");
  }, [accessKey, id]);

  useEffect(() => {
    let cancel = false;
    void (async () => {
      const cached = readCachedBook(id);
      if (cached && !cancel) setBook(cached);
      try {
        const res = await fetch(`/api/roadbooks/${id}`, { headers: bookHeaders(accessKey), cache: "no-store" });
        if (cancel) return;
        if (!res.ok) {
          if (!cached) setError(res.status === 401 ? "链接无效，或需要先在首页输入访问密码。" : "找不到这本路书。");
          else setNote("正在用本机缓存。晚了 1 小时仍可重排。");
          return;
        }
        const data = (await res.json()) as { book: Roadbook };
        const pending = readPending(id);
        if (pending.length === 0) {
          setBook(data.book);
          writeCachedBook(data.book);
          rememberBook({ id, accessKey, title: data.book.title, updatedAt: data.book.updatedAt });
        } else if (cached) {
          setBook(cached);
          await flush(cached);
        }
      } catch {
        if (cancel) return;
        if (!cached) setError("离线，而且这台浏览器还没有这本路书的缓存。");
        else setNote("离线，正在看缓存的路书和天气。晚了 1 小时仍可重排。");
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [id, accessKey, flush]);

  function remember(next: Roadbook) {
    setBook(next);
    writeCachedBook(next);
    rememberBook({ id, accessKey, title: next.title, updatedAt: next.updatedAt });
  }

  async function commit(request: PatchRequest) {
    const current = bookRef.current;
    if (!current) return;
    const withId: PatchRequest = { ...request, id: request.id || newPatchId() };
    if (!navigator.onLine) {
      const applied = applyPatch(current, withId);
      if (!applied.ok) {
        setNote(applied.error);
        return;
      }
      remember(applied.book);
      writePending(id, [...readPending(id), withId]);
      setNote(`${applied.book.statusLine} 联网后会同步。`);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/roadbooks/${id}/patch`, {
        method: "POST",
        headers: bookHeaders(accessKey),
        body: JSON.stringify(withId),
      });
      const data = (await res.json().catch(() => null)) as { book?: Roadbook; error?: string } | null;
      if (!res.ok || !data?.book) {
        setNote(data?.error || "没有改成。");
        return;
      }
      remember(data.book);
      setNote(data.book.statusLine);
    } catch {
      const applied = applyPatch(current, withId);
      if (!applied.ok) {
        setNote(applied.error);
        return;
      }
      remember(applied.book);
      writePending(id, [...readPending(id), withId]);
      setNote(`${applied.book.statusLine} 联网后会同步。`);
    } finally {
      setBusy(false);
    }
  }

  async function refine() {
    if (!navigator.onLine) return;
    setBusy(true);
    setNote("模型正在补一小处…");
    const res = await fetch(`/api/roadbooks/${id}/refine`, {
      method: "POST",
      headers: bookHeaders(accessKey),
    }).catch(() => null);
    setBusy(false);
    setHasKey(hasBrowserKey());
    if (!res) {
      setNote("没连上，本地草稿还在。");
      return;
    }
    const data = (await res.json().catch(() => null)) as { book?: Roadbook; note?: string; error?: string } | null;
    if (!res.ok || !data?.book) {
      setNote(data?.error || "模型没补上，本地草稿还在。");
      return;
    }
    remember(data.book);
    setNote(data.note || data.book.statusLine);
  }

  async function undo() {
    const current = bookRef.current;
    if (!current?.undo) {
      setNote("没有可撤销的补丁。");
      return;
    }
    const pending = readPending(id);
    const last = pending[pending.length - 1];
    if (last && last.id === current.undo.patchId) {
      const reverted = undoLast(current);
      if (!reverted.ok) {
        setNote(reverted.error);
        return;
      }
      writePending(id, pending.slice(0, -1));
      remember(reverted.book);
      setNote(reverted.book.statusLine);
      return;
    }
    if (!navigator.onLine) {
      const reverted = undoLast(current);
      if (!reverted.ok) {
        setNote(reverted.error);
        return;
      }
      remember(reverted.book);
      setNote("已在本机撤销。若服务器上还有这一笔，联网后再打开会以服务器为准。");
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/roadbooks/${id}/undo`, { method: "POST", headers: bookHeaders(accessKey) }).catch(() => null);
    setBusy(false);
    if (!res) {
      setNote("撤销请求没发出去。");
      return;
    }
    const data = (await res.json().catch(() => null)) as { book?: Roadbook; error?: string } | null;
    if (!res.ok || !data?.book) {
      setNote(data?.error || "没有可撤销的补丁。");
      return;
    }
    remember(data.book);
    setNote(data.book.statusLine);
  }

  function late() {
    if (busy) return;
    const current = bookRef.current;
    if (!current) return;
    const plan = planLate(current, new Date());
    if (!plan.request) {
      setNote(plan.note);
      return;
    }
    void commit(plan.request);
  }

  async function networked(action: "rain" | "tired") {
    if (!navigator.onLine) return;
    setBusy(true);
    const res = await fetch(`/api/roadbooks/${id}/rearrange`, {
      method: "POST",
      headers: bookHeaders(accessKey),
      body: JSON.stringify({ action }),
    }).catch(() => null);
    setBusy(false);
    if (!res) {
      setNote("没连上。联网后才能用这个按钮。");
      return;
    }
    const data = (await res.json().catch(() => null)) as { book?: Roadbook; note?: string; error?: string } | null;
    if (!res.ok || !data?.book) {
      setNote(data?.error || "没有改成。");
      return;
    }
    remember(data.book);
    setNote(data.note || data.book.statusLine);
  }

  async function onTalk(event: FormEvent) {
    event.preventDefault();
    const current = bookRef.current;
    const raw = text.trim();
    if (!current || !raw) return;
    setText("");
    setComposerError("");
    if (current.question) {
      const plan = planAnswer(current, raw, rid);
      if (!plan.request) {
        setComposerError(plan.note || "没有改成。");
        return;
      }
      await commit(plan.request);
      return;
    }
    const plan = planMessage(current, raw, rid);
    if (plan.request) {
      await commit(plan.request);
      return;
    }
    if (plan.note) {
      setComposerError(plan.note);
      return;
    }
    if (!navigator.onLine) {
      setNote("这句话要联网后交给模型。晚了 1 小时仍可离线重排。");
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/roadbooks/${id}/message`, {
      method: "POST",
      headers: bookHeaders(accessKey),
      body: JSON.stringify({ text: raw }),
    }).catch(() => null);
    setBusy(false);
    if (!res) {
      setNote("没连上。");
      return;
    }
    const data = (await res.json().catch(() => null)) as { book?: Roadbook; note?: string; error?: string } | null;
    if (!res.ok || !data?.book) {
      setNote(data?.error || "没有改成。");
      return;
    }
    remember(data.book);
    setNote(data.note || data.book.statusLine);
  }

  async function saveAssumption(assumptionId: string) {
    if (editingRef.current !== assumptionId) return;
    editingRef.current = null;
    setEditing(null);
    const current = bookRef.current;
    if (!current) return;
    const existing = current.assumptions.find((item) => item.id === assumptionId);
    if (existing && existing.value === editValue.trim()) return;
    const plan = planAssumptionEdit(current, assumptionId, editValue, rid);
    if (!plan.request) {
      setComposerError(plan.note || "没有改成。");
      return;
    }
    setComposerError("");
    await commit(plan.request);
  }

  if (loading && !book) {
    return <main className="grid h-dvh place-items-center text-sm text-muted-foreground">正在打开路书…</main>;
  }
  if (!book) {
    return (
      <main className="mx-auto flex h-dvh max-w-lg flex-col justify-center gap-3 px-4">
        <p>{error || "找不到这本路书。"}</p>
        <Link href="/" className="text-sm text-primary underline">
          回首页
        </Link>
      </main>
    );
  }

  const days = [...new Set(book.items.map((item) => item.dayIndex))].sort((a, b) => a - b);
  const highlighted = book.items.filter((item) => item.highlight);
  const dropped = book.patchHistory.at(-1)?.dropped ?? [];
  const talk = [
    { id: "brief", role: "user" as const, text: book.brief },
    ...book.patchHistory.map((patch) => {
      const removed = patch.dropped?.map((item) => item.title).filter(Boolean) ?? [];
      const extra = removed.length > 0 && !patch.label.includes(removed[0] ?? "") ? ` 拿掉了${removed.join("、")}。` : "";
      return { id: patch.id, role: "book" as const, text: `${patch.label}${extra}` };
    }),
  ];
  if (note && !talk.some((line) => line.text === note)) {
    talk.push({ id: "live", role: "book", text: note });
  }
  const composer = (
    <div className="space-y-2">
      {composerError ? (
        <p role="alert" className="rounded-xl border border-red-400 bg-red-50 px-3 py-2 text-base font-medium leading-6 text-red-800">
          {composerError}
        </p>
      ) : null}
      <form onSubmit={(event) => void onTalk(event)} className="flex gap-2">
        <input
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (composerError) setComposerError("");
          }}
          placeholder={book.question?.prompt || "想改哪里，写一句"}
          className="min-w-0 flex-1 rounded-xl border border-input bg-card px-3 py-3 text-base"
        />
        <button type="submit" className="rounded-xl bg-secondary px-3 text-sm">
          发送
        </button>
      </form>
    </div>
  );

  return (
    <main className="mx-auto flex h-dvh w-full max-w-lg flex-col lg:max-w-none lg:flex-row">
      <aside className="hidden h-dvh w-[22rem] shrink-0 flex-col border-r border-border bg-card/40 lg:flex">
        <div className="border-b border-border px-4 py-3">
          <Link href="/" className="text-xs text-muted-foreground">
            路书
          </Link>
          <h2 className="font-serif text-xl">对话</h2>
          <p className="text-xs text-muted-foreground">原句和每一次补丁。右边是路书。</p>
        </div>
        <div ref={talkPane} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
          {talk.map((line) => (
            <p
              key={line.id}
              className={
                line.role === "user"
                  ? "ml-6 rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground"
                  : "mr-6 rounded-2xl border border-border bg-background px-3 py-2 text-sm"
              }
            >
              {line.text}
            </p>
          ))}
        </div>
        <div className="border-t border-border p-3">{composer}</div>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="shrink-0 space-y-2 px-4 pt-3 pb-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Link href="/" className="text-xs text-muted-foreground">
              路书
            </Link>
            <h1 className="font-serif text-2xl leading-tight">{book.title}</h1>
          </div>
          <div className="flex shrink-0 gap-2">
            {hasKey ? (
              <button type="button" onClick={() => void refine()} className="rounded-full border border-border px-3 py-1 text-xs">
                模型补一处
              </button>
            ) : null}
            <button type="button" onClick={() => void undo()} className="rounded-full border border-border px-3 py-1 text-xs">
              撤销
            </button>
          </div>
        </div>
        {composerError ? (
          <p role="alert" className="rounded-xl border border-red-400 bg-red-50 px-3 py-2 text-base font-medium leading-6 text-red-800">
            {composerError}
          </p>
        ) : (
          <p className="text-xs leading-5 text-muted-foreground">{note || book.statusLine}</p>
        )}
        <p className="text-xs leading-5 text-muted-foreground">
          {book.city} · {weatherText(book)}
          {online ? "" : " · 离线缓存"}
        </p>
        <div className="flex flex-wrap gap-2">
          {book.assumptions.map((item) =>
            editing === item.id ? (
              <form
                key={item.id}
                className="flex items-center gap-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveAssumption(item.id);
                }}
              >
                <input
                  autoFocus
                  value={editValue}
                  aria-label={item.label}
                  onChange={(event) => setEditValue(event.target.value)}
                  onBlur={() => void saveAssumption(item.id)}
                  className="w-32 rounded-full border border-input bg-background px-3 py-1.5 text-[16px] leading-6"
                />
                <button
                  type="submit"
                  aria-label="保存"
                  className="grid h-9 w-9 place-items-center rounded-full bg-primary text-base text-primary-foreground"
                >
                  ✓
                </button>
              </form>
            ) : (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  editingRef.current = item.id;
                  setEditing(item.id);
                  setEditValue(item.value);
                }}
                data-changed={item.changed ? "1" : undefined}
                className={`rounded-full border px-2 py-1 text-xs ${item.changed ? "border-amber-400 bg-amber-100" : "border-border bg-card"}`}
                title={item.detail || item.label}
              >
                {item.label} {item.value}
                {item.changed ? " · 刚改" : item.inferred ? " · 推断" : ""}
              </button>
            ),
          )}
        </div>
        {book.question ? <p className="text-sm">还差一句：{book.question.prompt}</p> : null}
        {!hasKey ? <p className="text-xs text-muted-foreground">没填模型密钥，这是本地草稿。密钥只留在浏览器。</p> : null}
      </header>

      <div ref={bookPane} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        {highlighted.length > 0 || dropped.length > 0 ? (
          <ChangeHint
            highlighted={highlighted.map((item) => item.title)}
            dropped={dropped.map((item) => item.title)}
            days={book.assumptions.find((item) => item.key === "days")?.value}
            dayRewrite={book.patchHistory.at(-1)?.kind === "assumption" && /天/.test(book.patchHistory.at(-1)?.label ?? "")}
            open={changesOpen}
            onToggle={() => setChangesOpen((value) => !value)}
          />
        ) : null}
        {days.map((day) => {
          const daySnap = snapForTripDay(book, day);
          return (
          <section key={day} className="space-y-2">
            <h2 className="text-sm font-medium">
              第 {day} 天
              {daySnap?.available ? ` · ${daySnap.date ?? ""} ${daySnap.condition}` : ""}
            </h2>
            {book.items
              .filter((item) => item.dayIndex === day)
              .sort((a, b) => (parseTime(a.startTime) ?? 0) - (parseTime(b.startTime) ?? 0))
              .map((item) => (
                <article
                  key={item.id}
                  data-changed={item.highlight ? "1" : undefined}
                  className={`rounded-2xl border px-3 py-2 ${item.highlight ? "border-amber-400 bg-amber-100/80" : "border-border bg-card"}`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm font-medium">
                      {span(item)} {item.title}
                      {item.highlight ? <span className="ml-1 text-xs font-normal text-amber-800">刚改</span> : null}
                    </p>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        className="text-xs text-primary"
                        onClick={() => {
                          const done = item.status === "已完成";
                          void commit({
                            label: done ? `${item.title}改回待做` : `完成${item.title}`,
                            kind: "user",
                            ops: [{ op: "update", id: item.id, fields: { status: done ? "待做" : "已完成" } }],
                            statusNote: done ? `「${item.title}」改回待做。` : `「${item.title}」标成已完成。`,
                          });
                        }}
                      >
                        {item.status === "已完成" ? "改回待做" : "完成"}
                      </button>
                      {item.locked ? (
                        <button
                          type="button"
                          className="text-xs text-primary"
                          onClick={() =>
                            void commit({
                              label: `解锁${item.title}`,
                              kind: "user",
                              ops: [{ op: "update", id: item.id, fields: { locked: false } }],
                              statusNote: `已解锁「${item.title}」。之后可以再改时间和内容。`,
                            })
                          }
                        >
                          解锁
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="text-xs text-primary"
                          onClick={() =>
                            void commit({
                              label: `锁定${item.title}`,
                              kind: "user",
                              ops: [{ op: "update", id: item.id, fields: { locked: true } }],
                              statusNote: `已锁定「${item.title}」。重排不会动它。`,
                            })
                          }
                        >
                          锁定
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {item.place} · {item.type} · {item.priority} · {item.status}
                    {item.indoor ? " · 室内" : ""}
                    {item.travelEstimateMinutes != null ? ` · 路程约 ${item.travelEstimateMinutes} 分钟（${item.estimateSource || "推断"}）` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {item.source.kind}
                    {item.source.url ? (
                      <>
                        {" "}
                        <a href={item.source.url} className="underline" target="_blank" rel="noreferrer">
                          来源
                        </a>
                      </>
                    ) : null}
                    {item.note ? ` · ${item.note}` : ""}
                  </p>
                </article>
              ))}
          </section>
          );
        })}
        {book.verifyChecklist.length > 0 ? (
          <section className="pb-2">
            <h2 className="text-sm font-medium">出发前看一眼</h2>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-5 text-muted-foreground">
              {book.verifyChecklist.map((item) => (
                <li key={item.id}>{item.text}</li>
              ))}
            </ul>
          </section>
        ) : null}
        <KeySettings />
        <button
          type="button"
          className="text-xs text-primary"
          onClick={() => {
            const link = `${location.origin}/b/${id}/${accessKey}`;
            navigator.clipboard.writeText(link).then(
              () => setCopied(true),
              () => setNote(link),
            );
          }}
        >
          {copied ? "私密链接已复制" : "复制私密链接"}
        </button>
      </div>

      <footer className="shrink-0 space-y-2 border-t border-border bg-background/95 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <p className="text-[11px] text-muted-foreground">
          {online ? "必去的户外下雨会先问。其余只改今天未完成、未锁定的项。" : "离线 · 晚了 1 小时仍可用"}
        </p>
        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={late}
            disabled={busy}
            className="min-h-12 rounded-xl bg-primary px-1 text-xs text-primary-foreground disabled:opacity-50"
          >
            晚了 1 小时
            <span className="mt-0.5 block text-[10px] opacity-80">可离线</span>
          </button>
          <button
            type="button"
            disabled={!online || busy}
            onClick={() => void networked("rain")}
            className="min-h-12 rounded-xl border border-border bg-card px-1 text-xs disabled:opacity-50"
          >
            {online ? "下雨了" : "联网后可用"}
            {online ? <span className="mt-0.5 block text-[10px] text-muted-foreground">看天气</span> : null}
          </button>
          <button
            type="button"
            disabled={!online || busy}
            onClick={() => void networked("tired")}
            className="min-h-12 rounded-xl border border-border bg-card px-1 text-xs disabled:opacity-50"
          >
            {online ? "累了" : "联网后可用"}
            {online ? <span className="mt-0.5 block text-[10px] text-muted-foreground">少走路</span> : null}
          </button>
        </div>
        <div className="lg:hidden">{composer}</div>
      </footer>
      </div>
    </main>
  );
}
