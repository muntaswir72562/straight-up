import { sanitizeBookName } from './filename';
import type { PipelineResult, PipelinePhase, PipelineProgress } from './pipeline';

/**
 * Clean & Dewarp pipeline — server-side via Python.
 *
 * 1. Uploads the PDF to /api/clean (spawns Python subprocess)
 * 2. Polls /api/clean?id=… for page-by-page progress
 * 3. Downloads the result from /api/clean/download?id=…
 */
export async function runCleanPipeline(
  file: File,
  bookName: string,
  onProgress: (progress: PipelineProgress) => void,
  cancelRef: { cancelled: boolean }
): Promise<PipelineResult> {
  // --- Upload ---
  onProgress({ phase: 'preparing', current: 0, total: 0 });

  const form = new FormData();
  form.append('file', file);
  form.append('bookName', bookName);

  const startRes = await fetch('/api/clean', { method: 'POST', body: form });
  if (!startRes.ok) {
    const msg = await startRes.text();
    throw new Error(`Upload failed: ${msg}`);
  }
  const { jobId } = (await startRes.json()) as { jobId: string };

  if (cancelRef.cancelled) {
    await fetch(`/api/clean?id=${jobId}`, { method: 'DELETE' }).catch(() => {});
    throw new Error('Cancelled');
  }

  // --- Poll for progress ---
  let totalPages = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (cancelRef.cancelled) {
      await fetch(`/api/clean?id=${jobId}`, { method: 'DELETE' }).catch(() => {});
      throw new Error('Cancelled');
    }

    await new Promise((r) => setTimeout(r, 400));

    const res = await fetch(`/api/clean?id=${jobId}`);
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
      phase: (status.phase || 'cleaning') as PipelinePhase,
      current: status.current || 0,
      total: totalPages,
    });
  }

  // --- Download result via native browser download (avoids buffering entire PDF in JS) ---
  onProgress({ phase: 'merging', current: totalPages, total: totalPages });

  const safeName = sanitizeBookName(bookName);
  const downloadUrl = `/api/clean/download?id=${jobId}&name=${encodeURIComponent(safeName)}`;

  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = `${safeName}.pdf`;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => document.body.removeChild(link), 200);

  // Return empty blob — the browser is handling the download natively
  return {
    blob: new Blob(),
    filename: `${safeName}.pdf`,
    totalPages,
    angles: [],
  };
}
