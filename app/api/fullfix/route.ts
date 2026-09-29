import { NextRequest, NextResponse } from 'next/server';
import { spawn, type ChildProcess } from 'child_process';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { createWriteStream, existsSync } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

interface Job {
  tempDir: string;
  process: ChildProcess;
}

// Module-level job map (works in dev mode, single process)
const jobs = new Map<string, Job>();

/** POST — upload PDF and start full fix processing */
export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get('file') as File | null;
  const bookName = (formData.get('bookName') as string) || 'fixed';
  const straighten = formData.get('straighten') === '1' ? '1' : '0';
  const clean = formData.get('clean') === '1' ? '1' : '0';
  const dewarp = formData.get('dewarp') === '1' ? '1' : '0';

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }

  if (straighten === '0' && clean === '0' && dewarp === '0') {
    return NextResponse.json({ error: 'No operations selected' }, { status: 400 });
  }

  const jobId = randomUUID();
  const tempDir = join(tmpdir(), `straight-up-fullfix-${jobId}`);
  await mkdir(tempDir, { recursive: true });

  const inputPath = join(tempDir, 'input.pdf');
  const outputPath = join(tempDir, 'output.pdf');
  const progressPath = join(tempDir, 'progress.json');

  // Initial progress
  await writeFile(
    progressPath,
    JSON.stringify({ phase: 'preparing', current: 0, total: 0 }),
  );

  // Stream file to disk without buffering entire PDF in memory
  const nodeStream = Readable.fromWeb(file.stream() as never);
  await pipeline(nodeStream, createWriteStream(inputPath));

  // Spawn Python
  const scriptPath = join(process.cwd(), 'scripts', 'fullfix_pdf.py');
  const py = spawn('python', [
    scriptPath, inputPath, outputPath, progressPath, bookName, straighten, clean, dewarp,
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  jobs.set(jobId, { tempDir, process: py });

  py.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(data);
  });

  py.on('close', (code) => {
    console.log(`[api/fullfix] Job ${jobId} exited code=${code}`);
    if (code !== 0 && existsSync(progressPath)) {
      readFile(progressPath, 'utf8')
        .then((raw) => {
          const p = JSON.parse(raw);
          if (p.phase !== 'error' && p.phase !== 'done') {
            return writeFile(
              progressPath,
              JSON.stringify({ phase: 'error', error: `Process exited with code ${code}`, current: 0, total: 0 }),
            );
          }
        })
        .catch(() => {});
    }
  });

  return NextResponse.json({ jobId });
}

/** GET — poll for progress */
export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get('id');
  if (!jobId) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }

  const job = jobs.get(jobId);
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  const progressPath = join(job.tempDir, 'progress.json');
  try {
    const raw = await readFile(progressPath, 'utf8');
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json({ phase: 'preparing', current: 0, total: 0 });
  }
}

/** DELETE — cancel a running job */
export async function DELETE(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get('id');
  if (!jobId) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }

  const job = jobs.get(jobId);
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  try { job.process.kill(); } catch { /* already dead */ }
  jobs.delete(jobId);

  return NextResponse.json({ cancelled: true });
}
