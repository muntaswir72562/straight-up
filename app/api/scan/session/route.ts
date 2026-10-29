import { NextRequest, NextResponse } from 'next/server';
import {
  createSession, deleteSession, isSessionId, listSessions, normaliseOptions, updateSession,
} from '@/lib/server/scanStore';
import { getSessionChecked, scanWorker } from '@/lib/server/scanWorker';
import type {
  ScanOptions, ScanPageView, ScanSession, ScanSessionSummary, ScanSessionView,
} from '@/lib/scanTypes';

function view(s: ScanSession): ScanSessionView {
  const pages: ScanPageView[] = s.order.map((id) => {
    const isPh = id.startsWith('c');
    const capNo = parseInt(isPh ? id.slice(1) : id.split('_')[0], 10);
    const cap = s.captures[capNo];
    const idx = String(isPh ? 1 : s.pages[id]?.index ?? parseInt(id.split('_')[1], 10));
    const base = cap?.options ?? s.options;
    const pp = cap?.overrides?.pages?.[idx] ?? {};
    return {
      id,
      capture: capNo,
      placeholder: isPh,
      status: cap?.status ?? 'error',
      stage: cap ? scanWorker.stage(s.id, capNo) : undefined,
      error: cap?.error,
      info: isPh ? undefined : s.pages[id],
      options: {
        colorMode: pp.colorMode ?? base.colorMode,
        dewarp: pp.dewarp ?? base.dewarp,
        removeFingers: pp.removeFingers ?? base.removeFingers,
        split: cap?.overrides?.split ?? base.split,
      },
      rawDeleted: !!cap?.rawDeleted,
      version: cap?.doneAt ?? '0',
    };
  });
  const errors = Object.values(s.captures).filter((c) => c.status === 'error').length;
  return {
    id: s.id,
    bookName: s.bookName,
    options: s.options,
    updatedAt: s.updatedAt,
    exportedAt: s.exportedAt,
    pages,
    queue: { ...scanWorker.counts(s.id), errors },
    worker: { running: scanWorker.running, restarts: scanWorker.restarts },
  };
}

function summary(s: ScanSession): ScanSessionSummary {
  return {
    id: s.id,
    bookName: s.bookName,
    pageCount: s.order.filter((p) => !p.startsWith('c')).length,
    pending: Object.values(s.captures).filter((c) => c.status === 'queued' || c.status === 'processing').length,
    updatedAt: s.updatedAt,
    exportedAt: s.exportedAt,
  };
}

/** GET ?id=… one session with page statuses (poll it); no id: list all sessions. */
export async function GET(req: NextRequest) {
  await scanWorker.ensureStarted();
  const id = req.nextUrl.searchParams.get('id');
  if (!id) {
    return NextResponse.json({ sessions: (await listSessions()).map(summary) });
  }
  if (!isSessionId(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const s = await getSessionChecked(id);
  if (!s) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  return NextResponse.json(view(s));
}

/** POST { bookName, options } -> new session */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { bookName?: string; options?: Partial<ScanOptions> };
  const s = await createSession(String(body.bookName ?? '').slice(0, 200), body.options ?? {});
  return NextResponse.json(view(s));
}

/** PATCH { id, bookName?, options?, order? } */
export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    id?: string; bookName?: string; options?: Partial<ScanOptions>; order?: string[];
  };
  if (!isSessionId(body.id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  try {
    const s = await updateSession(body.id, (s) => {
      if (typeof body.bookName === 'string') s.bookName = body.bookName.slice(0, 200);
      if (body.options) s.options = normaliseOptions(body.options, s.options);
      if (Array.isArray(body.order)) {
        // a reorder must be a permutation of the current order
        const cur = [...s.order].sort().join('|');
        const next = [...body.order].sort().join('|');
        if (cur !== next) throw new Error('Order does not match the session pages');
        s.order = body.order;
      }
    });
    return NextResponse.json(view(s));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }
}

/** DELETE ?id=… discard a session and all its files */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (!isSessionId(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  await deleteSession(id);
  return NextResponse.json({ deleted: true });
}
