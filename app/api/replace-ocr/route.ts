import { NextRequest, NextResponse } from 'next/server';
import { spawn, type ChildProcess } from 'child_process';
import { writeFile, readFile, mkdir, rm } from 'fs/promises';
import { createWriteStream, existsSync } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

/** Time (ms) to keep temp files after job finishes, allowing user to download */
const CLEANUP_DELAY = 10 * 60 * 1000; // 10 minutes

interface Job {
  tempDir: string;
  process: ChildProcess | null;
  ocrPages: string; // comma-separated 1-based page numbers
}

// Module-level job map (works in dev mode, single process)
const jobs = new Map<string, Job>();

// --- Helpers ---

function spawnPython(jobId: string, job: Job): void {
  const inputPath = join(job.tempDir, 'input.pdf');
  const outputPath = join(job.tempDir, 'output.pdf');
  const progressPath = join(job.tempDir, 'progress.json');
  const scriptPath = join(process.cwd(), 'scripts', 'replace_ocr.py');

  const py = spawn('python', [
    scriptPath, inputPath, outputPath, progressPath, job.ocrPages,
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  job.process = py;

  py.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(data);
  });

  py.on('close', (code) => {
    console.log(`[api/replace-ocr] Job ${jobId} exited code=${code}`);
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
    // Clean up temp files and Map entry after a delay (allows time for download)
    setTimeout(() => {
      jobs.delete(jobId);
      rm(job.tempDir, { recursive: true, force: true }).catch(() => {});
    }, CLEANUP_DELAY);
  });
}

// --- Action: create job ---

async function handleCreate(formData: FormData) {
  const ocrPages = (formData.get('ocrPages') as string) || '';
  if (!ocrPages) {
    return NextResponse.json({ error: 'No OCR pages specified' }, { status: 400 });
  }

  const jobId = randomUUID();
  const tempDir = join(tmpdir(), `straight-up-replace-ocr-${jobId}`);
  await mkdir(tempDir, { recursive: true });

  await writeFile(
    join(tempDir, 'progress.json'),
    JSON.stringify({ phase: 'preparing', current: 0, total: 0 }),
  );

  jobs.set(jobId, { tempDir, process: null, ocrPages });

  return NextResponse.json({ jobId });
}

// --- Action: receive a chunk and append to input.pdf ---

async function handleChunk(formData: FormData) {
  const jobId = formData.get('jobId') as string | null;
  const chunk = formData.get('chunk') as File | null;

  if (!jobId || !chunk) {
    return NextResponse.json({ error: 'Missing jobId or chunk' }, { status: 400 });
  }

  const job = jobs.get(jobId);
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  const inputPath = join(job.tempDir, 'input.pdf');
  const nodeStream = Readable.fromWeb(chunk.stream() as never);
  await pipeline(nodeStream, createWriteStream(inputPath, { flags: 'a' }));

  return NextResponse.json({ ok: true });
}

// --- Action: all chunks uploaded, start Python processing ---

async function handleStart(formData: FormData) {
  const jobId = formData.get('jobId') as string | null;
  if (!jobId) {
    return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
  }

  const job = jobs.get(jobId);
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  if (job.process) {
    return NextResponse.json({ error: 'Job already started' }, { status: 409 });
  }

  const inputPath = join(job.tempDir, 'input.pdf');
  if (!existsSync(inputPath)) {
    return NextResponse.json({ error: 'No file uploaded yet' }, { status: 400 });
  }

  spawnPython(jobId, job);

  return NextResponse.json({ started: true });
}

// --- POST dispatcher ---

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const action = formData.get('action') as string | null;

  if (!action) {
    return NextResponse.json({ error: 'Missing action' }, { status: 400 });
  }

  switch (action) {
    case 'create': return handleCreate(formData);
    case 'chunk':  return handleChunk(formData);
    case 'start':  return handleStart(formData);
    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
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

  // Write cancel sentinel file
  await writeFile(join(job.tempDir, '_cancel'), '').catch(() => {});

  try { if (job.process) job.process.kill(); } catch { /* already dead */ }
  jobs.delete(jobId);
  rm(job.tempDir, { recursive: true, force: true }).catch(() => {});

  return NextResponse.json({ cancelled: true });
}
