import { AuthError, normalizeEmail, setSessionCookie, verifyEmailCode } from "@/lib/auth";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { email?: unknown; code?: unknown } | null;
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : null;
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!email) {
    return Response.json({ error: "请填一个邮箱。" }, { status: 400 });
  }
  if (!/^\d{6}$/.test(code)) {
    return Response.json({ error: "验证码是 6 位数字。" }, { status: 400 });
  }
  try {
    await verifyEmailCode(email, code);
    await setSessionCookie(email);
    return Response.json({ ok: true, email });
  } catch (error) {
    if (error instanceof AuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "没有登录成功。" }, { status: 500 });
  }
}
