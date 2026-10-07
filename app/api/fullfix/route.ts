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

interface JobMetadata {
  bookName: string;
  straighten: string;
  clean: string;
  dewarp: string;
  v2: string;
  skipClean: string;
  ocr: string;
  skipStraighten: string;
  skipDewarp: string;
  audit: string;
}

interface Job {
  tempDir: string;
  process: ChildProcess | null;
  metadata?: JobMetadata;
}

// Module-level job map (works in dev mode, single process)
const jobs = new Map<string, Job>();

// --- Helpers ---

function spawnPython(jobId: string, job: Job): void {
  const meta = job.metadata;
  if (!meta) throw new Error('No metadata for job');

  const inputPath = join(job.tempDir, 'input.pdf');
  const outputPath = join(job.tempDir, 'output.pdf');
  const progressPath = join(job.tempDir, 'progress.json');
  const scriptPath = join(process.cwd(), 'scripts', 'fullfix_pdf.py');

  const py = spawn('python', [
    scriptPath, inputPath, outputPath, progressPath,
    meta.bookName, meta.straighten, meta.clean, meta.dewarp, meta.v2,
    meta.skipClean, meta.ocr, meta.skipStraighten, meta.skipDewarp, meta.audit,
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  job.process = py;

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
    // Clean up temp files and Map entry after a delay (allows time for download)
    setTimeout(() => {
      jobs.delete(jobId);
      rm(job.tempDir, { recursive: true, force: true }).catch(() => {});
    }, CLEANUP_DELAY);
  });
}

function extractMetadata(formData: FormData): JobMetadata {
  return {
    bookName: (formData.get('bookName') as string) || 'fixed',
    straighten: formData.get('straighten') === '1' ? '1' : '0',
    clean: formData.get('clean') === '1' ? '1' : '0',
    dewarp: formData.get('dewarp') === '1' ? '1' : '0',
    v2: formData.get('v2') === '1' ? '1' : '0',
    skipClean: (formData.get('skipClean') as string) || '',
    ocr: formData.get('ocr') === '1' ? '1' : '0',
    skipStraighten: (formData.get('skipStraighten') as string) || '',
    skipDewarp: (formData.get('skipDewarp') as string) || '',
    audit: formData.get('audit') === '0' ? '0' : '1',
  };
}

function validateOptions(meta: JobMetadata): boolean {
  return meta.straighten === '1' || meta.clean === '1' || meta.dewarp === '1' || meta.v2 === '1' || meta.ocr === '1';
}

// --- Action: create job (no file yet) ---

async function handleCreate(formData: FormData) {
  const meta = extractMetadata(formData);
  if (!validateOptions(meta)) {
    return NextResponse.json({ error: 'No operations selected' }, { status: 400 });
  }

  const jobId = randomUUID();
  const tempDir = join(tmpdir(), `straight-up-fullfix-${jobId}`);
  await mkdir(tempDir, { recursive: true });

  await writeFile(
    join(tempDir, 'progress.json'),
    JSON.stringify({ phase: 'preparing', current: 0, total: 0 }),
  );

  jobs.set(jobId, { tempDir, process: null, metadata: meta });

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

// --- Legacy: single-request upload (backward compat) ---

async function handleLegacyUpload(formData: FormData) {
  const file = formData.get('file') as File | null;
  const meta = extractMetadata(formData);

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }
  if (!validateOptions(meta)) {
    return NextResponse.json({ error: 'No operations selected' }, { status: 400 });
  }

  const jobId = randomUUID();
  const tempDir = join(tmpdir(), `straight-up-fullfix-${jobId}`);
  await mkdir(tempDir, { recursive: true });

  await writeFile(
    join(tempDir, 'progress.json'),
    JSON.stringify({ phase: 'preparing', current: 0, total: 0 }),
  );

  const inputPath = join(tempDir, 'input.pdf');
  const nodeStream = Readable.fromWeb(file.stream() as never);
  await pipeline(nodeStream, createWriteStream(inputPath));

  const job: Job = { tempDir, process: null, metadata: meta };
  jobs.set(jobId, job);
  spawnPython(jobId, job);

  return NextResponse.json({ jobId });
}

// --- POST dispatcher ---

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const action = formData.get('action') as string | null;

  if (!action) {
    return handleLegacyUpload(formData);
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

  // Write cancel sentinel file (cooperative cancellation for OCR pool workers)
  await writeFile(join(job.tempDir, '_cancel'), '').catch(() => {});

  try { if (job.process) job.process.kill(); } catch { /* already dead */ }
  jobs.delete(jobId);
  rm(job.tempDir, { recursive: true, force: true }).catch(() => {});

  return NextResponse.json({ cancelled: true });
}
