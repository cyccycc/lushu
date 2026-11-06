import { clearGateCookie, gateOpen, passwordConfigured, setGateCookie } from "@/lib/gate";
import { timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";

function samePassword(input: string, expected: string): boolean {
  const left = Buffer.from(input);
  const right = Buffer.from(expected);
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function GET() {
  const required = passwordConfigured();
  return Response.json({ required, ok: required ? await gateOpen() : true });
}

export async function POST(request: Request) {
  const expected = process.env.ACCESS_PASSWORD?.trim() ?? "";
  if (!expected) {
    return Response.json({ error: "服务器没有设置 ACCESS_PASSWORD。" }, { status: 400 });
  }
  const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
  const password = typeof body?.password === "string" ? body.password : "";
  if (!samePassword(password, expected)) {
    return Response.json({ error: "密码不对。" }, { status: 401 });
  }
  await setGateCookie();
  return Response.json({ ok: true });
}

export async function DELETE() {
  await clearGateCookie();
  return Response.json({ ok: true });
}
