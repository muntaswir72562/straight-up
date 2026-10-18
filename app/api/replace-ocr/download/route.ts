import { NextRequest, NextResponse } from 'next/server';
import { existsSync, statSync, createReadStream } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Readable } from 'stream';

/** GET — stream the OCR'd PDF to the client */
export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get('id');
  const bookName = req.nextUrl.searchParams.get('name') || 'replaced';

  if (!jobId) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }

  const tempDir = join(tmpdir(), `straight-up-replace-ocr-${jobId}`);
  const filePath = join(tempDir, 'output.pdf');

  if (!existsSync(filePath)) {
    return NextResponse.json({ error: 'File not ready' }, { status: 404 });
  }

  const fileSize = statSync(filePath).size;
  const downloadName = `${bookName}.pdf`;

  // Stream the file instead of buffering it all in memory
  const nodeStream = createReadStream(filePath);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream;

  // Temp dir is cleaned up by the main route's 10-minute spawnPython timeout.
  // Do NOT delete here — runOcrOnServer auto-downloads via link.click(),
  // then the user may re-download from the ResultPanel.

  return new NextResponse(webStream, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(fileSize),
      'Content-Disposition': `attachment; filename="${encodeURIComponent(downloadName)}"`,
    },
  });
}
