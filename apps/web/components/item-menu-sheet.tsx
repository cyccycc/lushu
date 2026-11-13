"use client";

import { useState } from "react";
import {
  chooseItemSwap,
  describeItemMenu,
  formatTime,
  parseTime,
  planItemDelete,
  planItemDuration,
  planItemMove,
  planItemUnlock,
  planLockMust,
  type PatchRequest,
  type Roadbook,
  type RoadbookItem,
} from "@lushu/agent/roadbook";

function currentEnd(item: RoadbookItem): string {
  const start = parseTime(item.startTime);
  if (start == null) return item.startTime;
  const end = start + item.durationMinutes;
  if (end >= 24 * 60) return "23:59";
  return formatTime(end);
}

export function ItemMenuSheet({
  book,
  item,
  hasModelKey,
  busy,
  confirmUnlockOnOpen,
  onClose,
  onCommit,
  onModelSwap,
}: {
  book: Roadbook;
  item: RoadbookItem;
  hasModelKey: boolean;
  busy: boolean;
  confirmUnlockOnOpen?: boolean;
  onClose: () => void;
  onCommit: (request: PatchRequest) => void;
  onModelSwap: (text: string) => void;
}) {
  const menu = describeItemMenu(book, item.id, hasModelKey);
  const [moving, setMoving] = useState(false);
  const [lasting, setLasting] = useState(false);
  const [clock, setClock] = useState(item.startTime);
  const [endAt, setEndAt] = useState(currentEnd(item));
  const [confirmUnlock, setConfirmUnlock] = useState(Boolean(confirmUnlockOnOpen));
  const [whyOpen, setWhyOpen] = useState(false);
  const [hint, setHint] = useState("");
  if (typeof menu === "string") return null;

  function run(plan: { request: PatchRequest | null; note: string }) {
    if (!plan.request) {
      setHint(plan.note);
      return;
    }
    onCommit(plan.request);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/30" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-label={`${item.title}的菜单`}
        className="w-full max-w-lg rounded-t-2xl bg-background px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-sm font-medium">
            {item.startTime} {item.title}
          </p>
          <button type="button" className="text-xs text-muted-foreground" onClick={onClose}>
            关闭
          </button>
        </div>
        {hint ? <p className="mb-2 text-xs text-red-800">{hint}</p> : null}
        {whyOpen ? <p className="mb-3 text-sm leading-6">{menu.why}</p> : null}
        {confirmUnlock ? (
          <div className="mb-3 space-y-2">
            <p className="text-sm leading-6">这是原话里的安排。解锁后重排可以改它。</p>
            <div className="flex gap-2">
              <button
                type="button"
                className="min-h-11 flex-1 rounded-xl bg-primary text-sm text-primary-foreground"
                onClick={() => run(planItemUnlock(book, item.id, true))}
              >
                确定解锁
              </button>
              <button type="button" className="min-h-11 flex-1 rounded-xl border border-border text-sm" onClick={() => setConfirmUnlock(false)}>
                取消
              </button>
            </div>
          </div>
        ) : null}
        {moving ? (
          <form
            className="mb-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              run(planItemMove(book, item.id, clock.trim()));
            }}
          >
            <input
              autoFocus
              value={clock}
              aria-label="挪到的时间"
              onChange={(event) => setClock(event.target.value)}
              className="min-w-0 flex-1 rounded-xl border border-input bg-card px-3 py-2 text-base"
            />
            <button type="submit" className="rounded-xl bg-primary px-3 text-sm text-primary-foreground">
              改到这时
            </button>
          </form>
        ) : null}
        {lasting ? (
          <div className="mb-3 space-y-2">
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                run(planItemDuration(book, item.id, endAt.trim()));
              }}
            >
              <input
                autoFocus
                value={endAt}
                aria-label="结束时间"
                onChange={(event) => setEndAt(event.target.value)}
                className="min-w-0 flex-1 rounded-xl border border-input bg-card px-3 py-2 text-base"
              />
              <button type="submit" className="rounded-xl bg-primary px-3 text-sm text-primary-foreground">
                到这时结束
              </button>
            </form>
            <div className="grid grid-cols-4 gap-2">
              {[1, 2, 3, 4].map((hour) => (
                <button
                  key={hour}
                  type="button"
                  className="min-h-11 rounded-xl border border-border bg-card text-sm"
                  onClick={() => run(planItemDuration(book, item.id, hour * 60))}
                >
                  {hour} 小时
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          {menu.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={!action.enabled || busy}
              title={action.hint}
              className="min-h-12 rounded-xl border border-border bg-card px-2 text-sm disabled:opacity-50"
              onClick={() => {
                setHint(action.enabled ? "" : action.hint ?? "");
                if (!action.enabled) return;
                if (action.id === "why") {
                  setWhyOpen(true);
                  return;
                }
                if (action.id === "move") {
                  setLasting(false);
                  setMoving(true);
                  return;
                }
                if (action.id === "duration") {
                  setMoving(false);
                  setLasting(true);
                  return;
                }
                if (action.id === "swap") {
                  const choice = chooseItemSwap(book, item.id, hasModelKey);
                  if (choice.mode === "template") {
                    run({ request: choice.request, note: choice.note });
                    return;
                  }
                  if (choice.mode === "model") {
                    onModelSwap(choice.text);
                    onClose();
                    return;
                  }
                  setHint(choice.note);
                  return;
                }
                if (action.id === "delete") {
                  run(planItemDelete(book, item.id));
                  return;
                }
                if (action.id === "lock") {
                  run(planLockMust(book, item.id));
                  return;
                }
                if (menu.unlockNeedsConfirm) {
                  setConfirmUnlock(true);
                  return;
                }
                run(planItemUnlock(book, item.id, false));
              }}
            >
              {action.label}
              {!action.enabled && action.hint ? <span className="mt-0.5 block text-[10px] text-muted-foreground">{action.hint}</span> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
