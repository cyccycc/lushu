import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeRoadbook, type Roadbook } from "@lushu/agent/roadbook";

const ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const writes = new Map<string, Promise<void>>();

export type StoredRoadbook = {
  accessKey: string;
  /** Companion read key. Distinct from accessKey. Missing on books saved before sharing. */
  shareKey?: string;
  book: Roadbook;
};

export function isRoadbookId(id: string): boolean {
  return ID_RE.test(id);
}

export function createRoadbookId(): string {
  return randomBytes(9).toString("base64url");
}

export function createAccessKey(): string {
  return randomBytes(18).toString("base64url");
}

export function createShareKey(): string {
  return randomBytes(18).toString("base64url");
}

function directory(): string {
  const override = process.env.LUSHU_ROADBOOK_DIR?.trim();
  if (override) return path.resolve(override);
  return path.resolve(process.cwd(), "../../data/roadbooks");
}

function fileFor(id: string): string {
  if (!ID_RE.test(id)) throw new Error("invalid roadbook id");
  return path.join(directory(), `${id}.json`);
}

export async function saveRoadbook(stored: StoredRoadbook): Promise<void> {
  const folder = directory();
  await mkdir(folder, { recursive: true });
  const target = fileFor(stored.book.id);
  const tmp = `${target}.${process.pid}.tmp`;
  const next: StoredRoadbook = { ...stored, book: normalizeRoadbook(stored.book) };
  await writeFile(tmp, JSON.stringify(next));
  await rename(tmp, target);
}

export function enqueueRoadbook(stored: StoredRoadbook): Promise<void> {
  const snapshot = structuredClone(stored);
  const prev = writes.get(snapshot.book.id) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => saveRoadbook(snapshot));
  writes.set(snapshot.book.id, next);
  return next;
}

/** Keep accessKey, shareKey, and any later stored fields. Only the book changes. */
export function persistRoadbook(stored: StoredRoadbook, book: Roadbook): Promise<void> {
  return enqueueRoadbook({ ...stored, book });
}

export async function readRoadbook(id: string): Promise<StoredRoadbook | null> {
  if (!ID_RE.test(id)) return null;
  try {
    const raw = await readFile(fileFor(id), "utf8");
    const parsed = JSON.parse(raw) as StoredRoadbook;
    if (!parsed?.book || parsed.book.id !== id || typeof parsed.accessKey !== "string") return null;
    if (typeof parsed.shareKey !== "string" || !parsed.shareKey.trim()) delete parsed.shareKey;
    else parsed.shareKey = parsed.shareKey.trim();
    parsed.book = normalizeRoadbook(parsed.book);
    return parsed;
  } catch {
    return null;
  }
}

export async function listRoadbooks(): Promise<StoredRoadbook[]> {
  let names: string[] = [];
  try {
    names = await readdir(directory());
  } catch {
    return [];
  }
  const rows: StoredRoadbook[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.includes(".tmp")) continue;
    const stored = await readRoadbook(name.slice(0, -".json".length));
    if (stored) rows.push(stored);
  }
  rows.sort((a, b) => (a.book.updatedAt < b.book.updatedAt ? 1 : -1));
  return rows.slice(0, 50);
}

export async function ensureShareKey(stored: StoredRoadbook): Promise<StoredRoadbook> {
  if (stored.shareKey) return stored;
  const next = { ...stored, shareKey: createShareKey() };
  await enqueueRoadbook(next);
  return next;
}

export async function resetShareKey(stored: StoredRoadbook): Promise<StoredRoadbook> {
  const next = { ...stored, shareKey: createShareKey() };
  await enqueueRoadbook(next);
  return next;
}
