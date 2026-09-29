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

/** POST — upload PDF and start manual fix processing */
export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get('file') as File | null;
  const bookName = (formData.get('bookName') as string) || 'manual-fixed';
  const settingsJson = formData.get('settings') as string;

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }

  if (!settingsJson) {
    return NextResponse.json({ error: 'No settings provided' }, { status: 400 });
  }

  // Validate JSON
  try {
    JSON.parse(settingsJson);
  } catch {
    return NextResponse.json({ error: 'Invalid settings JSON' }, { status: 400 });
  }

  const jobId = randomUUID();
  const tempDir = join(tmpdir(), `straight-up-manualfix-${jobId}`);
  await mkdir(tempDir, { recursive: true });

  const inputPath = join(tempDir, 'input.pdf');
  const outputPath = join(tempDir, 'output.pdf');
  const progressPath = join(tempDir, 'progress.json');
  const settingsPath = join(tempDir, 'settings.json');

  // Initial progress
  await writeFile(
    progressPath,
    JSON.stringify({ phase: 'preparing', current: 0, total: 0 }),
  );

  // Write settings
  await writeFile(settingsPath, settingsJson);

  // Stream file to disk without buffering entire PDF in memory
  const nodeStream = Readable.fromWeb(file.stream() as never);
  await pipeline(nodeStream, createWriteStream(inputPath));

  // Spawn Python
  const scriptPath = join(process.cwd(), 'scripts', 'manualfix_pdf.py');
  const py = spawn('python', [
    scriptPath, inputPath, outputPath, progressPath, settingsPath, bookName,
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  jobs.set(jobId, { tempDir, process: py });

  py.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(data);
  });

  py.on('close', (code) => {
    console.log(`[api/manualfix] Job ${jobId} exited code=${code}`);
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
