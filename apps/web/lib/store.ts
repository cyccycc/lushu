import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeSession, type SessionRecord, type SessionSummary } from "./session-types";

const ID_RE = /^[A-Za-z0-9_-]{8,24}$/;
const active = new Set<string>();
const writes = new Map<string, Promise<void>>();

export function isSessionId(id: string): boolean {
  return ID_RE.test(id);
}

export function isActive(id: string): boolean {
  return active.has(id);
}

export function markActive(id: string): void {
  active.add(id);
}

export function clearActive(id: string): void {
  active.delete(id);
}

export function createSessionId(): string {
  return randomBytes(9).toString("base64url");
}

function directory(): string {
  return path.resolve(process.cwd(), "../../data/sessions");
}

function fileFor(id: string): string {
  if (!ID_RE.test(id)) throw new Error("invalid session id");
  return path.join(directory(), `${id}.json`);
}

export async function saveSession(session: SessionRecord): Promise<void> {
  const folder = directory();
  await mkdir(folder, { recursive: true });
  const target = fileFor(session.id);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(session, null, 2));
  await rename(tmp, target);
}

export function enqueueSave(session: SessionRecord): Promise<void> {
  const snapshot = structuredClone(session);
  const prev = writes.get(session.id) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => saveSession(snapshot));
  writes.set(session.id, next);
  return next;
}

export async function readSession(id: string): Promise<SessionRecord | null> {
  if (!ID_RE.test(id)) return null;
  try {
    const raw = await readFile(fileFor(id), "utf8");
    return normalizeSession(JSON.parse(raw) as SessionRecord);
  } catch {
    return null;
  }
}

export async function createSession(brief: string, ownerEmail: string | null = null): Promise<SessionRecord> {
  const now = new Date().toISOString();
  const session: SessionRecord = {
    id: createSessionId(),
    createdAt: now,
    updatedAt: now,
    brief,
    planningBrief: null,
    status: "draft",
    steps: [],
    usage: null,
    result: null,
    selectedVariantId: null,
    errorMessage: null,
    clarification: null,
    followUps: [],
    ownerEmail,
  };
  await saveSession(session);
  return session;
}

export async function listSessions(): Promise<SessionSummary[]> {
  let names: string[] = [];
  try {
    names = await readdir(directory());
  } catch {
    return [];
  }
  const rows: SessionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
    const session = await readSession(name.slice(0, -".json".length));
    if (!session) continue;
    const selected =
      session.result?.variants.find((item) => item.id === session.selectedVariantId) ??
      session.result?.variants[0];
    rows.push({
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      brief: session.brief,
      status: session.status,
      title: selected?.title ?? null,
      selectedVariantId: session.selectedVariantId,
      ownerEmail: session.ownerEmail,
    });
  }
  rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return rows.slice(0, 50);
}
