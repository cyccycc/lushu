"use client";

import { useEffect, useState } from "react";
import { hasBrowserKey } from "@/lib/browser-book";

const DEFAULT_BASE = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";

export function KeySettings() {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [base, setBase] = useState(DEFAULT_BASE);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setSaved(hasBrowserKey()));
    return () => cancelAnimationFrame(frame);
  }, []);

  function loadFields() {
    setApiKey(localStorage.getItem("lushu.llmKey") ?? "");
    setBase(localStorage.getItem("lushu.llmBase") || DEFAULT_BASE);
    setModel(localStorage.getItem("lushu.llmModel") || DEFAULT_MODEL);
  }

  return (
    <section className="rounded-2xl border border-border bg-card/80 p-3">
      <button
        type="button"
        className="text-sm font-medium text-primary"
        onClick={() => {
          loadFields();
          setOpen((value) => !value);
        }}
      >
        {saved ? "模型密钥已在这台浏览器" : "填写模型密钥"}
      </button>
      {open ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            const next = apiKey.trim();
            if (next) localStorage.setItem("lushu.llmKey", next);
            else localStorage.removeItem("lushu.llmKey");
            localStorage.setItem("lushu.llmBase", base.trim() || DEFAULT_BASE);
            localStorage.setItem("lushu.llmModel", model.trim() || DEFAULT_MODEL);
            setSaved(Boolean(next));
            setOpen(false);
          }}
        >
          <p className="text-xs leading-5 text-muted-foreground">
            密钥只存在这台浏览器。生成或改写时随请求交给服务器，用完即弃，不写进路书，也不写日志。不填也能出本地草稿。
          </p>
          <label className="block text-xs text-muted-foreground">
            API Key
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              className="mt-1 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-xs text-muted-foreground">
            接口地址
            <input
              value={base}
              onChange={(event) => setBase(event.target.value)}
              className="mt-1 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-xs text-muted-foreground">
            模型
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className="mt-1 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          <div className="flex gap-2">
            <button type="submit" className="rounded-xl bg-primary px-3 py-2 text-sm text-primary-foreground">
              保存在这台浏览器
            </button>
            <button
              type="button"
              className="rounded-xl border border-border px-3 py-2 text-sm"
              onClick={() => {
                localStorage.removeItem("lushu.llmKey");
                setApiKey("");
                setSaved(false);
              }}
            >
              清除密钥
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
