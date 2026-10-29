import { NextRequest, NextResponse } from 'next/server';
import { createReadStream, existsSync, statSync } from 'fs';
import { Readable } from 'stream';
import { isPageId, isSessionId, pagePath } from '@/lib/server/scanStore';

/** GET ?session=…&page=…&size=thumb|full  — a processed page image. */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const session = sp.get('session');
  const page = sp.get('page');
  if (!isSessionId(session) || !isPageId(page)) {
    return NextResponse.json({ error: 'Invalid session or page' }, { status: 400 });
  }
  const file = pagePath(session, page, sp.get('size') === 'thumb' ? '.thumb.jpg' : '.jpg');
  if (!existsSync(file)) return NextResponse.json({ error: 'Not ready' }, { status: 404 });
  return new NextResponse(Readable.toWeb(createReadStream(file)) as ReadableStream, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(statSync(file).size),
      // URLs carry a version (&v=…), so a cached image is never stale
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}
