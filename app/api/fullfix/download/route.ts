import { NextRequest, NextResponse } from 'next/server';
import { rm } from 'fs/promises';
import { existsSync, statSync, createReadStream } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Readable } from 'stream';

/** GET — stream the processed PDF to the client, then clean up */
export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get('id');
  const bookName = req.nextUrl.searchParams.get('name') || 'fixed';

  if (!jobId) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }

  const tempDir = join(tmpdir(), `straight-up-fullfix-${jobId}`);
  const outputPath = join(tempDir, 'output.pdf');

  if (!existsSync(outputPath)) {
    return NextResponse.json({ error: 'Output not ready' }, { status: 404 });
  }

  const fileSize = statSync(outputPath).size;

  // Stream the file instead of buffering it all in memory
  const nodeStream = createReadStream(outputPath);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream;

  // Clean up temp files after the stream is consumed
  nodeStream.on('close', () => {
    rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  return new NextResponse(webStream, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(fileSize),
      'Content-Disposition': `attachment; filename="${encodeURIComponent(bookName)}.pdf"`,
    },
  });
}
