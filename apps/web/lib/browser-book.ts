import type { PatchRequest, Roadbook } from "@lushu/agent/roadbook";

export type RecentBook = {
  id: string;
  accessKey: string;
  title: string;
  updatedAt: string;
};

export function readRecent(): RecentBook[] {
  try {
    const parsed = JSON.parse(localStorage.getItem("lushu.recent") || "[]") as RecentBook[];
    return Array.isArray(parsed) ? parsed.slice(0, 20) : [];
  } catch {
    return [];
  }
}

export function rememberBook(entry: RecentBook): void {
  const next = [entry, ...readRecent().filter((item) => item.id !== entry.id)].slice(0, 20);
  localStorage.setItem("lushu.recent", JSON.stringify(next));
}

/** Overwrite lushu.recent. Does not read or merge the previous list. */
export function replaceRecent(entries: readonly RecentBook[]): void {
  localStorage.setItem("lushu.recent", JSON.stringify(entries));
}

/**
 * Books from a successful list response that should replace the local cache.
 * Null means this payload is not an authoritative list (locked placeholder, or no books array).
 * An empty array is authoritative and must clear the cache.
 */
export function recentReplacement<T extends RecentBook>(
  data: { books?: T[] | null; listLocked?: boolean } | null | undefined,
): T[] | null {
  if (!data || data.listLocked || !Array.isArray(data.books)) return null;
  return data.books;
}

export function readCachedBook(id: string): Roadbook | null {
  try {
    const raw = localStorage.getItem(`lushu.book.${id}`);
    return raw ? (JSON.parse(raw) as Roadbook) : null;
  } catch {
    return null;
  }
}

export function writeCachedBook(book: Roadbook): void {
  localStorage.setItem(`lushu.book.${book.id}`, JSON.stringify(book));
}

export function readPending(id: string): PatchRequest[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(`lushu.pending.${id}`) || "[]") as PatchRequest[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writePending(id: string, patches: PatchRequest[]): void {
  if (patches.length === 0) localStorage.removeItem(`lushu.pending.${id}`);
  else localStorage.setItem(`lushu.pending.${id}`, JSON.stringify(patches));
}

export function llmRequestHeaders(headers = new Headers()): Headers {
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const apiKey = localStorage.getItem("lushu.llmKey")?.trim();
  if (apiKey) headers.set("X-Lushu-LLM-Key", apiKey);
  const base = localStorage.getItem("lushu.llmBase")?.trim();
  const model = localStorage.getItem("lushu.llmModel")?.trim();
  if (base) headers.set("X-Lushu-LLM-Base", base);
  if (model) headers.set("X-Lushu-LLM-Model", model);
  return headers;
}

export function bookHeaders(accessKey: string): Headers {
  const headers = llmRequestHeaders();
  headers.set("X-Lushu-Book-Key", accessKey);
  return headers;
}

export function hasBrowserKey(): boolean {
  return Boolean(localStorage.getItem("lushu.llmKey")?.trim());
}

export function newPatchId(): string {
  return `p_${Date.now().toString(36)}`;
}
