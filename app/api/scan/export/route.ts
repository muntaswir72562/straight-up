import { NextRequest, NextResponse } from 'next/server';
import type { ChildProcess } from 'child_process';
import { createReadStream, existsSync, statSync } from 'fs';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { Readable } from 'stream';
import { isSessionId, readSession, sessionDir, updateSession } from '@/lib/server/scanStore';
import { spawnPipeline } from '@/lib/server/python';
import { sanitizeBookName } from '@/lib/filename';

/**
 * POST { sessionId, txt?, audit? }  start building the searchable PDF from pages/ (session order)
 * GET  ?sessionId=…                 progress { phase, current, total }
 * GET  ?sessionId=…&download=pdf|txt|audit
 *
 * The export lives in <session>/export/ and is rebuilt on every export.
 */

const g = globalThis as unknown as { __scanExports?: Map<string, ChildProcess> };
const running = (g.__scanExports ??= new Map());

function exportDir(id: string) {
  return join(sessionDir(id), 'export');
}

export async function POST(req: NextRequest) {
  const b = (await req.json().catch(() => ({}))) as { sessionId?: string; txt?: boolean; audit?: boolean };
  if (!isSessionId(b.sessionId)) return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 });
  const id = b.sessionId;
  const s = await readSession(id);
  if (!s) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  const pending = Object.values(s.captures).some((c) => c.status === 'queued' || c.status === 'processing');
  if (pending) return NextResponse.json({ error: 'Pages are still processing' }, { status: 409 });
  if (!s.order.some((p) => !p.startsWith('c'))) {
    return NextResponse.json({ error: 'No pages to export' }, { status: 409 });
  }
  if (running.has(id)) return NextResponse.json({ error: 'Export already running' }, { status: 409 });

  const dir = exportDir(id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const progress = join(dir, 'progress.json');
  await writeFile(progress, JSON.stringify({ phase: 'preparing', current: 0, total: 0 }));

  const py = spawnPipeline('scan-export', [
    sessionDir(id), join(dir, 'output.pdf'), progress, b.txt === false ? '0' : '1', b.audit ? '1' : '0',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  running.set(id, py);
  py.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
  py.on('close', (code) => {
    running.delete(id);
    console.log(`[api/scan/export] ${id} exited code=${code}`);
    if (code === 0) {
      updateSession(id, (s) => { s.exportedAt = new Date().toISOString(); }).catch(() => {});
    } else {
      readFile(progress, 'utf8').then((raw) => {
        if (JSON.parse(raw).phase !== 'error') {
          return writeFile(progress, JSON.stringify({ phase: 'error', error: `Export exited with code ${code}`, current: 0, total: 0 }));
        }
      }).catch(() => {});
    }
  });
  py.on('error', (e) => {
    running.delete(id);
    writeFile(progress, JSON.stringify({ phase: 'error', error: e.message, current: 0, total: 0 })).catch(() => {});
  });
  return NextResponse.json({ started: true });
}

const FILES = {
  pdf: { file: 'output.pdf', type: 'application/pdf', suffix: '.pdf' },
  txt: { file: 'ocr_text.txt', type: 'text/plain; charset=utf-8', suffix: '_ocr.txt' },
  audit: { file: 'page_audit.json', type: 'application/json', suffix: '_audit.json' },
} as const;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const id = sp.get('sessionId');
  if (!isSessionId(id)) return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 });
  const dir = exportDir(id);
  const dl = sp.get('download') as keyof typeof FILES | null;
  if (!dl) {
    try {
      return NextResponse.json(JSON.parse(await readFile(join(dir, 'progress.json'), 'utf8')));
    } catch {
      return NextResponse.json({ phase: 'none', current: 0, total: 0 });
    }
  }
  const f = FILES[dl];
  if (!f) return NextResponse.json({ error: 'Unknown download' }, { status: 400 });
  const path = join(dir, f.file);
  if (!existsSync(path)) return NextResponse.json({ error: 'File not ready' }, { status: 404 });
  const s = await readSession(id);
  const name = `${sanitizeBookName(s?.bookName || 'scan')}${f.suffix}`;
  return new NextResponse(Readable.toWeb(createReadStream(path)) as ReadableStream, {
    headers: {
      'Content-Type': f.type,
      'Content-Length': String(statSync(path).size),
      'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`,
    },
  });
}
