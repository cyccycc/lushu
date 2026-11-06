"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [delivery, setDelivery] = useState<"smtp" | "log" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function requestCode() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await response.json()) as { error?: string; delivery?: "smtp" | "log" };
      if (!response.ok) {
        setError(data.error ?? "没有发出验证码。");
        setPending(false);
        return;
      }
      setDelivery(data.delivery ?? "log");
      setSent(true);
    } catch {
      setError("网络没有连上。");
    }
    setPending(false);
  }

  async function verify() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(data.error ?? "没有登录成功。");
        setPending(false);
        return;
      }
      router.push("/mine");
      router.refresh();
    } catch {
      setError("网络没有连上。");
      setPending(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (sent) void verify();
        else void requestCode();
      }}
    >
      <label htmlFor="email" className="block font-serif text-lg">
        邮箱
      </label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        required
        value={email}
        placeholder="you@example.com"
        className="h-11 w-full rounded-xl border border-border bg-card px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        onChange={(event) => setEmail(event.target.value)}
      />
      {sent ? (
        <>
          <label htmlFor="code" className="block text-sm font-medium">
            6 位验证码
          </label>
          <input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            value={code}
            className="h-11 w-full rounded-xl border border-border bg-card px-3 text-base tracking-[0.3em] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            onChange={(event) => setCode(event.target.value)}
          />
          <p className="text-sm leading-6 text-muted-foreground">
            {delivery === "smtp"
              ? "验证码已发到这个邮箱，10 分钟内有效。"
              : "这台机器还没配邮件服务器。验证码打印在运行路书的终端里，不会出现在页面上。"}
          </p>
        </>
      ) : (
        <p className="text-sm leading-6 text-muted-foreground">
          只用邮箱验证码登录。没有账号的话，验证通过就会建好。不使用手机号，也不向你收费。
        </p>
      )}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" size="lg" className="h-11 rounded-full px-6" disabled={pending}>
        {pending ? "请稍等…" : sent ? "登录" : "发送验证码"}
      </Button>
    </form>
  );
}
