import { createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cookies } from "next/headers";

const COOKIE = "lushu_session";
const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

type OtpRecord = {
  salt: string;
  hash: string;
  expiresAt: number;
  sentAt: number;
  attempts: number;
};

type AuthUser = {
  email: string;
  exp: number;
};

type OtpFile = Record<string, OtpRecord>;

function authDir(): string {
  return path.resolve(process.cwd(), "../../data/auth");
}

let secretCache: string | null = null;

async function secret(): Promise<string> {
  if (secretCache) return secretCache;
  const fromEnv = process.env.AUTH_SECRET?.trim();
  if (fromEnv) {
    secretCache = fromEnv;
    return fromEnv;
  }
  const file = path.join(authDir(), "dev-secret");
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (existing) {
      secretCache = existing;
      return existing;
    }
  } catch {
    // Create a machine-local secret so login works before AUTH_SECRET is set.
  }
  const created = randomBytes(32).toString("base64url");
  await mkdir(authDir(), { recursive: true });
  await writeFile(file, created, { flag: "wx" }).catch(async () => {
    const existing = (await readFile(file, "utf8")).trim();
    if (existing) secretCache = existing;
  });
  secretCache = secretCache ?? created;
  return secretCache;
}

export function normalizeEmail(input: string): string | null {
  const value = input.trim().toLowerCase();
  if (!value || value.length > 120) return null;
  if (/^[+\d][\d\s-]{5,}$/.test(value)) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  return value;
}

function hashCode(code: string, salt: string): string {
  return scryptSync(code, salt, 32).toString("base64url");
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function readOtps(): Promise<OtpFile> {
  try {
    return JSON.parse(await readFile(path.join(authDir(), "otp.json"), "utf8")) as OtpFile;
  } catch {
    return {};
  }
}

async function writeOtps(data: OtpFile): Promise<void> {
  await mkdir(authDir(), { recursive: true });
  await writeFile(path.join(authDir(), "otp.json"), JSON.stringify(data));
}

export async function issueEmailCode(email: string): Promise<{ delivery: "smtp" | "log" }> {
  const now = Date.now();
  const all = await readOtps();
  const previous = all[email];
  if (previous && now - previous.sentAt < RESEND_MS && previous.expiresAt > now) {
    throw new AuthError("请等一分钟再要新的验证码。", 429);
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const salt = randomBytes(16).toString("base64url");
  all[email] = {
    salt,
    hash: hashCode(code, salt),
    expiresAt: now + OTP_TTL_MS,
    sentAt: now,
    attempts: 0,
  };
  await writeOtps(all);
  return deliverCode(email, code);
}

export async function verifyEmailCode(email: string, code: string): Promise<void> {
  const all = await readOtps();
  const record = all[email];
  if (!record || record.expiresAt < Date.now()) {
    throw new AuthError("验证码已经失效，请重新获取。", 400);
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    delete all[email];
    await writeOtps(all);
    throw new AuthError("试得太多了，请重新获取验证码。", 400);
  }
  const ok = sameText(record.hash, hashCode(code, record.salt));
  if (!ok) {
    record.attempts += 1;
    all[email] = record;
    await writeOtps(all);
    throw new AuthError("验证码不对。", 400);
  }
  delete all[email];
  await writeOtps(all);
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

async function deliverCode(email: string, code: string): Promise<{ delivery: "smtp" | "log" }> {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) {
    console.info(`[lushu] 邮箱验证码 ${email}：${code}（未配置 SMTP_HOST，只打印在终端）`);
    return { delivery: "log" };
  }
  const nodemailer = await import("nodemailer");
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER?.trim();
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass: process.env.SMTP_PASS ?? "" } : undefined,
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM?.trim() || "路书 <noreply@localhost>",
    to: email,
    subject: "路书登录验证码",
    text: `路书登录验证码：${code}\n10 分钟内有效。路书不会用这个验证码收费或订票。\n如果不是你本人操作，忽略这封邮件即可。`,
  });
  return { delivery: "smtp" };
}

async function seal(email: string): Promise<string> {
  const payload = Buffer.from(
    JSON.stringify({ email, exp: Date.now() + SESSION_MS } satisfies AuthUser),
    "utf8",
  ).toString("base64url");
  const sig = createHmac("sha256", await secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function openToken(token: string, key: string): AuthUser | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", key).update(payload).digest("base64url");
  if (!sameText(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AuthUser;
    if (!data?.email || typeof data.exp !== "number" || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export async function currentUser(): Promise<AuthUser | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  return openToken(token, await secret());
}

export async function setSessionCookie(email: string): Promise<void> {
  const jar = await cookies();
  jar.set({
    name: COOKIE,
    value: await seal(email),
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MS / 1000,
    secure: process.env.NODE_ENV === "production",
  });
}

export async function clearSessionCookie(): Promise<void> {
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
