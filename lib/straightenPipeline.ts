import { sanitizeBookName } from './filename';
import type { PipelineResult, PipelinePhase, PipelineProgress } from './pipeline';
import type { SlotData } from './types';
import { assemblePdf, type AssemblePage } from './pdf/assemble';

/**
 * Straighten pipeline — server-side via Python.
 *
 * 1. Uploads the PDF to /api/straighten (spawns Python subprocess)
 * 2. Polls /api/straighten?id=… for page-by-page progress
 * 3. Downloads the result from /api/straighten/download?id=…
 */
export async function runStraightenPipeline(
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

  const startRes = await fetch('/api/straighten', { method: 'POST', body: form });
  if (!startRes.ok) {
    const msg = await startRes.text();
    throw new Error(`Upload failed: ${msg}`);
  }
  const { jobId } = (await startRes.json()) as { jobId: string };

  if (cancelRef.cancelled) {
    await fetch(`/api/straighten?id=${jobId}`, { method: 'DELETE' }).catch(() => {});
    throw new Error('Cancelled');
  }

  // --- Poll for progress ---
  let totalPages = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (cancelRef.cancelled) {
      await fetch(`/api/straighten?id=${jobId}`, { method: 'DELETE' }).catch(() => {});
      throw new Error('Cancelled');
    }

    await new Promise((r) => setTimeout(r, 400));

    const res = await fetch(`/api/straighten?id=${jobId}`);
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
      phase: (status.phase || 'straightening') as PipelinePhase,
      current: status.current || 0,
      total: totalPages,
    });
  }

  // --- Download result via native browser download ---
  onProgress({ phase: 'merging', current: totalPages, total: totalPages });

  const safeName = sanitizeBookName(bookName);
  const downloadUrl = `/api/straighten/download?id=${jobId}&name=${encodeURIComponent(safeName)}`;

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
  };
}

/**
 * Merge & Straighten pipeline:
 * 1. Merge multiple PDF slots into one PDF (JS, client-side)
 * 2. Upload merged PDF to Python for straightening
 */
export async function runMergeStraightenPipeline(
  slots: SlotData[],
  bookName: string,
  onProgress: (progress: PipelineProgress) => void,
  cancelRef: { cancelled: boolean }
): Promise<PipelineResult> {
  const filledSlots = slots.filter((s) => s.file !== null);

  if (filledSlots.length === 0) {
    throw new Error('No files to merge.');
  }

  // --- Phase 1: Merge PDFs (client-side) ---
  onProgress({ phase: 'merging', current: 0, total: 0 });

  const pdfBytesArray: Uint8Array[] = [];
  for (const slot of filledSlots) {
    if (cancelRef.cancelled) throw new Error('Cancelled');
    const buffer = await slot.file!.arrayBuffer();
    pdfBytesArray.push(new Uint8Array(buffer));
  }

  const totalPages = filledSlots.reduce((sum, s) => sum + (s.pageCount ?? 0), 0);

  const assemblePages: AssemblePage[] = [];
  for (let pdfIdx = 0; pdfIdx < pdfBytesArray.length; pdfIdx++) {
    const slot = filledSlots[pdfIdx];
    const pageCount = slot.pageCount ?? 0;
    for (let p = 0; p < pageCount; p++) {
      assemblePages.push({ kind: 'untouched', pdfIndex: pdfIdx, pageIndex: p });
    }
  }

  const merged = await assemblePdf(
    { pdfs: pdfBytesArray, bookTitle: bookName.trim() },
    assemblePages,
    (current, total) => onProgress({ phase: 'merging', current, total }),
    cancelRef
  );

  if (cancelRef.cancelled) throw new Error('Cancelled');

  // --- Phase 2: Send merged PDF to Python for straightening ---
  const mergedFile = new File(
    [merged.buffer as ArrayBuffer],
    'merged.pdf',
    { type: 'application/pdf' }
  );

  return runStraightenPipeline(mergedFile, bookName, onProgress, cancelRef);
}
