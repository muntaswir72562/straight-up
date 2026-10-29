import { NextRequest, NextResponse } from 'next/server';
import { unlink } from 'fs/promises';
import {
  captureOfPage, isPageId, isSessionId, pagePath, updateSession,
} from '@/lib/server/scanStore';
import { scanWorker } from '@/lib/server/scanWorker';
import type { ColorMode, SplitMode } from '@/lib/scanTypes';

const PLACEHOLDER = /^c\d{4,}$/;

interface OverrideBody {
  sessionId?: string;
  pageId?: string;
  action?: 'override' | 'retry';
  split?: SplitMode;
  rotate?: number;          // degrees to add (90, -90, 180)
  keepColour?: boolean;
  colorMode?: ColorMode;
  dewarp?: boolean;
  removeFingers?: boolean;
}

function captureOf(pageId: string): number {
  return PLACEHOLDER.test(pageId) ? parseInt(pageId.slice(1), 10) : captureOfPage(pageId);
}

/**
 * POST { sessionId, pageId, action: 'override', split?|rotate?|keepColour?|colorMode?|dewarp?|removeFingers? }
 * POST { sessionId, pageId, action: 'retry' }
 * Reprocesses the page's capture from its raw photo with the new options.
 */
export async function POST(req: NextRequest) {
  await scanWorker.ensureStarted();
  const b = (await req.json().catch(() => ({}))) as OverrideBody;
  if (!isSessionId(b.sessionId)) return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 });
  if (typeof b.pageId !== 'string' || !(isPageId(b.pageId) || PLACEHOLDER.test(b.pageId))) {
    return NextResponse.json({ error: 'Invalid pageId' }, { status: 400 });
  }
  const pageId = b.pageId;
  const no = captureOf(pageId);
  try {
    await updateSession(b.sessionId, (s) => {
      const c = s.captures[no];
      if (!c) throw new Error('Capture not found');
      const idx = String(s.pages[pageId]?.index ?? 1);
      const o = c.overrides;
      if (b.action !== 'retry') {
        if (b.split === 'auto' || b.split === 'one' || b.split === 'two') {
          o.split = b.split;
          c.deleted = [];          // page ids change with the split
          o.rotate = {};
          o.keepColour = {};
        }
        if (typeof b.rotate === 'number' && b.rotate % 90 === 0) {
          o.rotate = { ...(o.rotate ?? {}), [idx]: ((((o.rotate?.[idx] ?? 0) + b.rotate) % 360) + 360) % 360 };
        }
        if (typeof b.keepColour === 'boolean') o.keepColour = { ...(o.keepColour ?? {}), [idx]: b.keepColour };
        if (b.colorMode === 'clean' || b.colorMode === 'colour') o.colorMode = b.colorMode;
        if (typeof b.dewarp === 'boolean') o.dewarp = b.dewarp;
        if (typeof b.removeFingers === 'boolean') o.removeFingers = b.removeFingers;
      }
      c.status = 'queued';
      c.error = undefined;
      c.attempts = 0;
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 404 });
  }
  scanWorker.enqueue(b.sessionId, no);
  return NextResponse.json({ queued: true, capture: no });
}

/** DELETE ?sessionId=…&pageId=… removes the page from the book (the raw photo is kept). */
export async function DELETE(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId');
  const pageId = req.nextUrl.searchParams.get('pageId');
  if (!isSessionId(sessionId)) return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 });
  if (!pageId || !(isPageId(pageId) || PLACEHOLDER.test(pageId))) {
    return NextResponse.json({ error: 'Invalid pageId' }, { status: 400 });
  }
  const no = captureOf(pageId);
  try {
    await updateSession(sessionId, (s) => {
      s.order = s.order.filter((p) => p !== pageId);
      const c = s.captures[no];
      if (c) {
        if (PLACEHOLDER.test(pageId)) {
          c.deleted = [...(c.deleted ?? []), ...c.pages];
        } else {
          c.deleted = [...(c.deleted ?? []), pageId];
        }
      }
      // (a capture with nothing left in `order` is never placed again: placePages)
      delete s.pages[pageId];
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 404 });
  }
  if (isPageId(pageId)) {
    for (const ext of ['.jpg', '.thumb.jpg', '.ocr.json', '.meta.json']) {
      await unlink(pagePath(sessionId, pageId, ext)).catch(() => {});
    }
  }
  return NextResponse.json({ deleted: true });
}
