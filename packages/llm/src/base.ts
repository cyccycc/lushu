import { isIP } from "node:net";

function ipv4Blocked(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const a = nums[0] ?? 0;
  const b = nums[1] ?? 0;
  const c = nums[2] ?? 0;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function ipv6Blocked(host: string): boolean {
  const ip = host.toLowerCase();
  if (ip === "::" || ip === "::1") return true;
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(ip)) return true;
  const dotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) return ipv4Blocked(dotted[1]);
  return false;
}

export function isBlockedLlmHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (
    bare === "localhost" ||
    bare.endsWith(".localhost") ||
    bare.endsWith(".local") ||
    bare === "metadata.google.internal" ||
    bare === "metadata"
  ) {
    return true;
  }
  if (/^\d+$/.test(bare)) return true;
  const version = isIP(bare);
  if (version === 4) return ipv4Blocked(bare);
  if (version === 6) return ipv6Blocked(bare);
  return false;
}

/** Public https base only. Anything else, including private and localhost, uses fallback. */
export function publicHttpsBase(value: string | null | undefined, fallback: string): string {
  const raw = (value ?? "").trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return fallback;
    if (url.username || url.password) return fallback;
    if (isBlockedLlmHost(url.hostname)) return fallback;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

/** Shown when the user supplied a model address we will not call. */
export const blockedModelUrlMessage = "这个模型地址不允许使用。";

/**
 * Empty input keeps the fallback.
 * A supplied address that is not public https is rejected instead of being swapped for the fallback.
 * Swapping a private host for the default API makes the next 401 look like a bad key.
 */
export function resolveLlmBase(
  value: string | null | undefined,
  fallback: string,
): { ok: true; baseURL: string } | { ok: false; reason: "blocked" } {
  const raw = (value ?? "").trim();
  if (!raw) return { ok: true, baseURL: fallback };
  const normalized = publicHttpsBase(raw, "");
  if (!normalized) return { ok: false, reason: "blocked" };
  return { ok: true, baseURL: normalized };
}

/** Status only. Do not attach the upstream body — it can be an internal response. */
export function modelHttpError(status: number): string {
  if (status === 401 || status === 403) return "模型密钥无效，或没有调用权限。";
  return `模型接口返回 ${status}。`;
}
