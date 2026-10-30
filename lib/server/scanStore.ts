import { mkdir, readFile, readdir, rename, writeFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { CropRect, ScanOptions, ScanSession, ScanCapture, ScanPageInfo } from '@/lib/scanTypes';

/**
 * Scan Book sessions live on disk (not in memory, not in the temp dir), so a
 * crash or restart never loses a scan:
 *
 *   <SCAN_DATA_DIR>/<session-id>/
 *     session.json        book name, options, captures, page order
 *     raw/capture_0001.jpg
 *     pages/page_0001_1.jpg, .thumb.jpg, .ocr.json, .meta.json
 *     export/             last export (PDF, .txt, audit)
 */

export function dataDir(): string {
  // runtime path, not a build input: keep the tracer from pulling in the whole project
  return process.env.SCAN_DATA_DIR || join(/*turbopackIgnore: true*/ process.cwd(), 'scan-data');
}

const SESSION_ID = /^[0-9a-f-]{36}$/;
const PAGE_ID = /^\d{4,}_\d$/;

export function isSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID.test(id);
}

export function isPageId(id: unknown): id is string {
  return typeof id === 'string' && PAGE_ID.test(id);
}

export function sessionDir(id: string): string {
  if (!isSessionId(id)) throw new Error('Invalid session id');
  return join(dataDir(), id);
}

export function rawPath(id: string, capture: number): string {
  return join(sessionDir(id), 'raw', `capture_${String(capture).padStart(4, '0')}.jpg`);
}

export function pagePath(id: string, pageId: string, ext: string): string {
  if (!isPageId(pageId)) throw new Error('Invalid page id');
  return join(sessionDir(id), 'pages', `page_${pageId}${ext}`);
}

/** Placeholder in `order` for a capture that has no pages yet. */
export function placeholder(capture: number): string {
  return `c${String(capture).padStart(4, '0')}`;
}

export function captureOfPage(pageId: string): number {
  return parseInt(pageId.split('_')[0], 10);
}

// ── Locking: one writer per session at a time ────────────────────────

const g = globalThis as unknown as { __scanLocks?: Map<string, Promise<unknown>> };
const locks = (g.__scanLocks ??= new Map());

async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  locks.set(id, run);
  try {
    return await run;
  } finally {
    if (locks.get(id) === run) locks.delete(id);
  }
}

// ── Read / write ─────────────────────────────────────────────────────

/**
 * On Windows a file that another request is reading can't be replaced
 * (rename fails with EPERM/EBUSY) and can briefly fail to open. The UI polls
 * session.json every second while scanning, so these are retried instead of
 * failing the write (which used to drop the capture from the queue).
 */
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function retryFs<T>(fn: () => Promise<T>, tries = 12): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || !TRANSIENT.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await new Promise((r) => setTimeout(r, 25 * i));
    }
  }
}

export async function readSession(id: string): Promise<ScanSession | null> {
  try {
    return JSON.parse(await retryFs(() => readFile(join(sessionDir(id), 'session.json'), 'utf8'))) as ScanSession;
  } catch {
    return null;
  }
}

async function writeSession(s: ScanSession): Promise<void> {
  s.updatedAt = new Date().toISOString();
  const p = join(sessionDir(s.id), 'session.json');
  const tmp = `${p}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(s, null, 1));
  await retryFs(() => rename(tmp, p));
}

/** Read-modify-write under the session lock. Returns the updated session. */
export async function updateSession(
  id: string,
  fn: (s: ScanSession) => void | Promise<void>,
): Promise<ScanSession> {
  return withLock(id, async () => {
    const s = await readSession(id);
    if (!s) throw new Error('Session not found');
    await fn(s);
    await writeSession(s);
    return s;
  });
}

export const DEFAULT_OPTIONS: ScanOptions = {
  colorMode: 'clean',
  dewarp: true,
  removeFingers: true,
  split: 'auto',
};

function validCrop(c: unknown): CropRect | null {
  if (!c || typeof c !== 'object') return null;
  const { x, y, w, h } = c as Record<string, unknown>;
  if (![x, y, w, h].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const r = { x: x as number, y: y as number, w: w as number, h: h as number };
  if (r.x < 0 || r.y < 0 || r.w < 0.05 || r.h < 0.05 || r.x + r.w > 1.0001 || r.y + r.h > 1.0001) return null;
  return r;
}

export function normaliseOptions(o: Partial<ScanOptions> | undefined, base = DEFAULT_OPTIONS): ScanOptions {
  return {
    crop: o && 'crop' in o ? validCrop(o.crop) : base.crop ?? null,
    colorMode: o?.colorMode === 'colour' || o?.colorMode === 'clean' ? o.colorMode : base.colorMode,
    dewarp: typeof o?.dewarp === 'boolean' ? o.dewarp : base.dewarp,
    removeFingers: typeof o?.removeFingers === 'boolean' ? o.removeFingers : base.removeFingers,
    split: o?.split === 'auto' || o?.split === 'one' || o?.split === 'two' ? o.split : base.split,
  };
}

export async function createSession(bookName: string, options: Partial<ScanOptions>): Promise<ScanSession> {
  const id = randomUUID();
  const dir = sessionDir(id);
  await mkdir(join(dir, 'raw'), { recursive: true });
  await mkdir(join(dir, 'pages'), { recursive: true });
  const now = new Date().toISOString();
  const s: ScanSession = {
    id,
    bookName: bookName || 'scan',
    options: normaliseOptions(options),
    createdAt: now,
    updatedAt: now,
    nextCapture: 1,
    captures: {},
    order: [],
    pages: {},
  };
  await writeSession(s);
  return s;
}

export async function listSessions(): Promise<ScanSession[]> {
  const root = dataDir();
  if (!existsSync(/*turbopackIgnore: true*/ root)) return [];
  const out: ScanSession[] = [];
  for (const name of await readdir(/*turbopackIgnore: true*/ root)) {
    if (!isSessionId(name)) continue;
    const s = await readSession(name);
    if (s) out.push(s);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteSession(id: string): Promise<void> {
  await withLock(id, () => rm(sessionDir(id), { recursive: true, force: true }));
}

/**
 * After a successful export: delete the raw photos of the finished captures
 * (about 80 % of a book's size). Pages, OCR and the PDF stay. Captures that
 * failed or are waiting keep their photo, so they can still be retried.
 * Returns the number of photos deleted.
 */
export async function deleteRawPhotos(id: string): Promise<number> {
  let n = 0;
  await updateSession(id, async (s) => {
    for (const c of Object.values(s.captures)) {
      if (c.status !== 'done' || c.rawDeleted) continue;
      await rm(rawPath(id, c.no), { force: true });
      c.rawDeleted = true;
      n++;
    }
  });
  return n;
}

/** Pages of a finished capture go where its placeholder / old pages were. */
export function placePages(s: ScanSession, cap: ScanCapture, ids: string[], infos: Record<string, ScanPageInfo>) {
  const ph = placeholder(cap.no);
  const old = new Set(cap.pages);
  for (const p of cap.pages) delete s.pages[p];
  const keep = ids.filter((p) => !(cap.deleted ?? []).includes(p));
  const at = s.order.findIndex((x) => x === ph || old.has(x));
  s.order = s.order.filter((x) => x !== ph && !old.has(x));
  if (at >= 0) s.order.splice(Math.min(at, s.order.length), 0, ...keep);
  cap.pages = ids;
  for (const p of ids) s.pages[p] = infos[p];
}
