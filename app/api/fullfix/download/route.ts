import { NextRequest, NextResponse } from 'next/server';
import { rm } from 'fs/promises';
import { existsSync, statSync, createReadStream } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Readable } from 'stream';

/** GET — stream the processed PDF (or sidecar file) to the client */
export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get('id');
  const bookName = req.nextUrl.searchParams.get('name') || 'fixed';
  const fileType = req.nextUrl.searchParams.get('type') || 'pdf';

  if (!jobId) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }

  const tempDir = join(tmpdir(), `straight-up-fullfix-${jobId}`);

  // Resolve file path and content type based on requested type
  let filePath: string;
  let contentType: string;
  let downloadName: string;

  switch (fileType) {
    case 'json':
      filePath = join(tempDir, 'ocr_results.json');
      contentType = 'application/json';
      downloadName = `${bookName}_ocr.json`;
      break;
    case 'txt':
      filePath = join(tempDir, 'ocr_text.txt');
      contentType = 'text/plain; charset=utf-8';
      downloadName = `${bookName}_ocr.txt`;
      break;
    default:
      filePath = join(tempDir, 'output.pdf');
      contentType = 'application/pdf';
      downloadName = `${bookName}.pdf`;
      break;
  }

  if (!existsSync(filePath)) {
    return NextResponse.json({ error: 'File not ready' }, { status: 404 });
  }

  const fileSize = statSync(filePath).size;

  // Stream the file instead of buffering it all in memory
  const nodeStream = createReadStream(filePath);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream;

  // Only clean up temp dir after PDF download (the primary deliverable).
  // Sidecar downloads leave the dir intact for the subsequent PDF download.
  if (fileType === 'pdf') {
    nodeStream.on('close', () => {
      rm(tempDir, { recursive: true, force: true }).catch(() => {});
    });
  }

  return new NextResponse(webStream, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(fileSize),
      'Content-Disposition': `attachment; filename="${encodeURIComponent(downloadName)}"`,
    },
  });
}
