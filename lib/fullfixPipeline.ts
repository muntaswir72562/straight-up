import { sanitizeBookName } from './filename';
import type { PipelineResult, PipelinePhase, PipelineProgress } from './pipeline';

/** Upload chunk size — 400 MB */
const CHUNK_SIZE = 400 * 1024 * 1024;

/**
 * Full Book Fix pipeline — server-side via Python.
 *
 * 1. Creates a job on the server
 * 2. Uploads the PDF in ~200 MB chunks (File.slice — zero client memory overhead)
 * 3. Starts processing on the server
 * 4. Polls /api/fullfix?id=… for page-by-page progress
 * 5. Downloads the result from /api/fullfix/download?id=…
 */
export async function runFullfixPipeline(
  file: File,
  bookName: string,
  options: { straighten: boolean; clean: boolean; dewarp: boolean; v2: boolean; skipClean?: string; ocr?: boolean; skipStraighten?: string; skipDewarp?: string },
  onProgress: (progress: PipelineProgress) => void,
  cancelRef: { cancelled: boolean }
): Promise<PipelineResult> {
  // --- Step 1: Create job ---
  onProgress({ phase: 'preparing', current: 0, total: 0 });

  const createForm = new FormData();
  createForm.append('action', 'create');
  createForm.append('bookName', bookName);
  createForm.append('straighten', options.straighten ? '1' : '0');
  createForm.append('clean', options.clean ? '1' : '0');
  createForm.append('dewarp', options.dewarp ? '1' : '0');
  createForm.append('v2', options.v2 ? '1' : '0');
  if (options.skipClean) {
    createForm.append('skipClean', options.skipClean);
  }
  createForm.append('ocr', options.ocr ? '1' : '0');
  if (options.skipStraighten) {
    createForm.append('skipStraighten', options.skipStraighten);
  }
  if (options.skipDewarp) {
    createForm.append('skipDewarp', options.skipDewarp);
  }

  const createRes = await fetch('/api/fullfix', { method: 'POST', body: createForm });
  if (!createRes.ok) {
    const msg = await createRes.text();
    throw new Error(`Failed to create job: ${msg}`);
  }
  const { jobId } = (await createRes.json()) as { jobId: string };

  if (cancelRef.cancelled) {
    await fetch(`/api/fullfix?id=${jobId}`, { method: 'DELETE' }).catch(() => {});
    throw new Error('Cancelled');
  }

  // --- Step 2: Upload in chunks ---
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  for (let i = 0; i < totalChunks; i++) {
    if (cancelRef.cancelled) {
      await fetch(`/api/fullfix?id=${jobId}`, { method: 'DELETE' }).catch(() => {});
      throw new Error('Cancelled');
    }

    onProgress({ phase: 'preparing', current: i + 1, total: totalChunks });

    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const blob = file.slice(start, end);

    const chunkForm = new FormData();
    chunkForm.append('action', 'chunk');
    chunkForm.append('jobId', jobId);
    chunkForm.append('chunkIndex', String(i));
    chunkForm.append('chunk', blob);

    const chunkRes = await fetch('/api/fullfix', { method: 'POST', body: chunkForm });
    if (!chunkRes.ok) {
      await fetch(`/api/fullfix?id=${jobId}`, { method: 'DELETE' }).catch(() => {});
      const msg = await chunkRes.text();
      throw new Error(`Upload failed: ${msg}`);
    }
  }

  if (cancelRef.cancelled) {
    await fetch(`/api/fullfix?id=${jobId}`, { method: 'DELETE' }).catch(() => {});
    throw new Error('Cancelled');
  }

  // --- Step 3: Start processing ---
  const startForm = new FormData();
  startForm.append('action', 'start');
  startForm.append('jobId', jobId);

  const startRes = await fetch('/api/fullfix', { method: 'POST', body: startForm });
  if (!startRes.ok) {
    const msg = await startRes.text();
    throw new Error(`Failed to start processing: ${msg}`);
  }

  // --- Step 4: Poll for progress ---
  let totalPages = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (cancelRef.cancelled) {
      await fetch(`/api/fullfix?id=${jobId}`, { method: 'DELETE' }).catch(() => {});
      throw new Error('Cancelled');
    }

    await new Promise((r) => setTimeout(r, 400));

    const res = await fetch(`/api/fullfix?id=${jobId}`);
    if (!res.ok) throw new Error('Failed to check status');
    const status = (await res.json()) as {
      phase: string;
      current: number;
      total: number;
      error?: string;
    };

    if (status.phase === 'error') {
      throw new Error(status.error || 'Processing failed');
    }

    if (status.phase === 'done') {
      totalPages = status.total || status.current;
      break;
    }

    totalPages = status.total || 0;
    onProgress({
      phase: (status.phase || 'fixing') as PipelinePhase,
      current: status.current || 0,
      total: totalPages,
    });
  }

  // --- Step 5: Download result via native browser download ---
  onProgress({ phase: 'merging', current: totalPages, total: totalPages });

  const safeName = sanitizeBookName(bookName);
  const downloadUrl = `/api/fullfix/download?id=${jobId}&name=${encodeURIComponent(safeName)}`;

  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = `${safeName}.pdf`;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => document.body.removeChild(link), 200);

  return {
    blob: new Blob(),
    filename: `${safeName}.pdf`,
    totalPages,
    angles: [],
    downloadUrl,
  };
}
