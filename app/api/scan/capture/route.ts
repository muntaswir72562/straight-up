import { NextRequest, NextResponse } from 'next/server';
import { createWriteStream } from 'fs';
import { rename, rm } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import {
  captureOfPage, isPageId, isSessionId, placeholder, rawPath, sessionDir, updateSession,
} from '@/lib/server/scanStore';
import { scanWorker } from '@/lib/server/scanWorker';

/**
 * POST multipart { sessionId, photo: File, replace?: pageId }
 *
 * The photo is written to raw/ before anything else, so a crash during
 * processing never loses the scan. `replace` (retake) puts the new capture
 * where that page was and drops the old page.
 */
export async function POST(req: NextRequest) {
  await scanWorker.ensureStarted();
  const form = await req.formData();
  const sessionId = form.get('sessionId');
  const photo = form.get('photo') as File | null;
  const replace = form.get('replace');
  if (!isSessionId(sessionId)) return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 });
  if (!photo || typeof photo === 'string') return NextResponse.json({ error: 'No photo' }, { status: 400 });
  if (replace && !isPageId(replace)) return NextResponse.json({ error: 'Invalid replace' }, { status: 400 });

  const tmp = join(sessionDir(sessionId), 'raw', `upload_${randomUUID()}.tmp`);
  try {
    await pipeline(Readable.fromWeb(photo.stream() as never), createWriteStream(tmp));
  } catch (e) {
    await rm(tmp, { force: true });
    return NextResponse.json({ error: `Could not save photo: ${(e as Error).message}` }, { status: 500 });
  }

  let no = 0;
  try {
    await updateSession(sessionId, async (s) => {
      no = s.nextCapture++;
      await rename(tmp, rawPath(sessionId, no));
      s.captures[no] = {
        no,
        options: { ...s.options },
        overrides: {},
        status: 'queued',
        attempts: 0,
        createdAt: new Date().toISOString(),
        pages: [],
      };
      const ph = placeholder(no);
      const at = typeof replace === 'string' ? s.order.indexOf(replace) : -1;
      if (at >= 0 && typeof replace === 'string') {
        s.order.splice(at, 1, ph);
        const old = s.captures[captureOfPage(replace)];
        if (old) old.deleted = [...(old.deleted ?? []), replace];
        delete s.pages[replace];
      } else {
        s.order.push(ph);
      }
    });
  } catch (e) {
    await rm(tmp, { force: true });
    return NextResponse.json({ error: (e as Error).message }, { status: 404 });
  }
  scanWorker.enqueue(sessionId, no);
  return NextResponse.json({ capture: no });
}
