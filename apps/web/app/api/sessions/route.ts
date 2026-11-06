import { currentUser } from "@/lib/auth";
import { denyIfClosed } from "@/lib/gate";
import { createSession, listSessions } from "@/lib/store";

export async function GET() {
  const denied = await denyIfClosed();
  if (denied) return denied;
  const sessions = await listSessions();
  const user = await currentUser();
  return Response.json({ sessions, email: user?.email ?? null });
}

export async function POST(request: Request) {
  const denied = await denyIfClosed();
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as { brief?: unknown } | null;
  const brief = typeof body?.brief === "string" ? body.brief.trim() : "";
  if (brief.length < 2) {
    return Response.json({ error: "先写一句去哪儿、几天。" }, { status: 400 });
  }
  if (brief.length > 2000) {
    return Response.json({ error: "请写在 2000 字以内。" }, { status: 400 });
  }
  const user = await currentUser();
  const session = await createSession(brief, user?.email ?? null);
  return Response.json({ session });
}
