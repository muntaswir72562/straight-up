import type {
  ColorMode, ScanOptions, ScanSessionSummary, ScanSessionView, SplitMode,
} from './scanTypes';

/** Browser-side calls to /api/scan/*. */

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = ((await res.json()) as { error?: string }).error || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export async function listSessions(): Promise<ScanSessionSummary[]> {
  return (await json<{ sessions: ScanSessionSummary[] }>(await fetch('/api/scan/session', { cache: 'no-store' }))).sessions;
}

export async function createSession(bookName: string, options: ScanOptions): Promise<ScanSessionView> {
  return json(await fetch('/api/scan/session', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ bookName, options }),
  }));
}

export async function getSession(id: string): Promise<ScanSessionView> {
  return json(await fetch(`/api/scan/session?id=${id}`, { cache: 'no-store' }));
}

export async function patchSession(
  id: string, patch: { bookName?: string; options?: ScanOptions; order?: string[] },
): Promise<ScanSessionView> {
  return json(await fetch('/api/scan/session', {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ id, ...patch }),
  }));
}

export async function uploadCapture(sessionId: string, photo: Blob, replace?: string): Promise<{ capture: number }> {
  const form = new FormData();
  form.append('sessionId', sessionId);
  form.append('photo', photo, 'capture.jpg');
  if (replace) form.append('replace', replace);
  return json(await fetch('/api/scan/capture', { method: 'POST', body: form }));
}

export interface PageOverride {
  split?: SplitMode;
  rotate?: number;
  keepColour?: boolean;
  colorMode?: ColorMode;
  dewarp?: boolean;
  removeFingers?: boolean;
}

export async function overridePage(sessionId: string, pageId: string, o: PageOverride): Promise<void> {
  await json(await fetch('/api/scan/page', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ sessionId, pageId, action: 'override', ...o }),
  }));
}

export async function retryPage(sessionId: string, pageId: string): Promise<void> {
  await json(await fetch('/api/scan/page', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ sessionId, pageId, action: 'retry' }),
  }));
}

export async function deletePage(sessionId: string, pageId: string): Promise<void> {
  await json(await fetch(`/api/scan/page?sessionId=${sessionId}&pageId=${encodeURIComponent(pageId)}`, { method: 'DELETE' }));
}

export async function startExport(sessionId: string, txt: boolean): Promise<void> {
  await json(await fetch('/api/scan/export', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ sessionId, txt, audit: false }),
  }));
}

export async function exportProgress(sessionId: string): Promise<{ phase: string; current: number; total: number; error?: string }> {
  return json(await fetch(`/api/scan/export?sessionId=${sessionId}`, { cache: 'no-store' }));
}

export function exportUrl(sessionId: string, kind: 'pdf' | 'txt'): string {
  return `/api/scan/export?sessionId=${sessionId}&download=${kind}`;
}

export function imageUrl(sessionId: string, pageId: string, size: 'thumb' | 'full', version: string): string {
  return `/api/scan/image?session=${sessionId}&page=${encodeURIComponent(pageId)}&size=${size}&v=${encodeURIComponent(version)}`;
}
