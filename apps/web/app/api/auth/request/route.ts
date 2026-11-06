import { AuthError, issueEmailCode, normalizeEmail } from "@/lib/auth";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : null;
  if (!email) {
    const raw = typeof body?.email === "string" ? body.email.trim() : "";
    const phone = /^[+\d][\d\s-]{5,}$/.test(raw);
    return Response.json(
      { error: phone ? "只用邮箱验证码，不支持手机号。" : "请填一个邮箱。" },
      { status: 400 },
    );
  }
  try {
    const result = await issueEmailCode(email);
    return Response.json({ ok: true, delivery: result.delivery });
  } catch (error) {
    if (error instanceof AuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "验证码没有发出去。" }, { status: 500 });
  }
}
