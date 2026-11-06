import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

const COOKIE = "lushu_gate";
const MAX_AGE = 30 * 24 * 60 * 60;

export function passwordConfigured(): boolean {
  return Boolean(process.env.ACCESS_PASSWORD?.trim());
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function gateSecret(): string {
  return process.env.AUTH_SECRET?.trim() || process.env.ACCESS_PASSWORD?.trim() || "lushu-dev-gate";
}

function expectedToken(): string {
  const password = process.env.ACCESS_PASSWORD?.trim() ?? "";
  return createHmac("sha256", gateSecret()).update(`gate:${password}`).digest("base64url");
}

export async function gateOpen(): Promise<boolean> {
  if (!passwordConfigured()) return false;
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return false;
  return safeEqual(token, expectedToken());
}

export async function setGateCookie(): Promise<void> {
  const jar = await cookies();
  jar.set({
    name: COOKIE,
    value: expectedToken(),
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
    secure: process.env.NODE_ENV === "production",
  });
}

export async function clearGateCookie(): Promise<void> {
  const jar = await cookies();
  jar.set({
    name: COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    secure: process.env.NODE_ENV === "production",
  });
}

export function bookKeyFrom(request: Request): string {
  const header = request.headers.get("x-lushu-book-key")?.trim() ?? "";
  if (header) return header;
  return new URL(request.url).searchParams.get("k")?.trim() ?? "";
}

export function keyMatches(provided: string, expected: string): boolean {
  return safeEqual(provided, expected);
}

export async function canReadBook(request: Request, accessKey: string): Promise<boolean> {
  if (keyMatches(bookKeyFrom(request), accessKey)) return true;
  return gateOpen();
}
