import { PDFDocument } from 'pdf-lib';
import { assemblePdf, type AssemblePage } from './pdf/assemble';
import { sanitizeBookName } from './filename';
import { JPEG_QUALITY, MAX_RENDER_DIMENSION, RENDER_DPI } from './constants';
import type { PipelineResult, PipelinePhase, PipelineProgress } from './pipeline';
import type { Insertion } from '@/components/PageGrid';

function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

/** Upload chunk size — 400 MB */
const CHUNK_SIZE = 400 * 1024 * 1024;

/**
 * Convert an image File (JPEG, PNG, WebP) to JPEG bytes via canvas.
 */
async function imageFileToJpeg(file: File, quality: number): Promise<Uint8Array> {
  const url = URL.createObjectURL(file);

  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`Failed to load image: ${file.name}`));
      img.src = url;
    });

    // Cap dimensions to prevent OOM on very large scanned images
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    const maxDim = Math.max(w, h);
    if (maxDim > MAX_RENDER_DIMENSION) {
      const scale = MAX_RENDER_DIMENSION / maxDim;
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, w, h);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Canvas toBlob failed'))),
        'image/jpeg',
        quality
      );
    });

    const buffer = await blob.arrayBuffer();
    return new Uint8Array(buffer);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Convert the first page of a PDF File to JPEG bytes via pdfjs-dist + canvas.
 */
async function pdfFileToJpeg(file: File, quality: number): Promise<Uint8Array> {
  const { loadPdfDocument } = await import('@/lib/pdf/render');

  const pdf = await loadPdfDocument(file);
  try {
    const page = await pdf.getPage(1);
    const viewport1 = page.getViewport({ scale: 1 });

    let scale = RENDER_DPI / 72;
    let w = Math.round(viewport1.width * scale);
    let h = Math.round(viewport1.height * scale);

    const maxDim = Math.max(w, h);
    if (maxDim > MAX_RENDER_DIMENSION) {
      scale *= MAX_RENDER_DIMENSION / maxDim;
      w = Math.round(viewport1.width * scale);
      h = Math.round(viewport1.height * scale);
    }

    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;

    await page.render({ canvasContext: ctx, viewport }).promise;
    page.cleanup();

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Canvas toBlob failed'))),
        'image/jpeg',
        quality
      );
    });

    const buffer = await blob.arrayBuffer();
    return new Uint8Array(buffer);
  } finally {
    pdf.destroy();
  }
}

/**
 * Convert a File (image or PDF) to JPEG bytes.
 */
async function fileToJpeg(file: File, quality: number): Promise<Uint8Array> {
  if (isPdfFile(file)) {
    return pdfFileToJpeg(file, quality);
  }
  return imageFileToJpeg(file, quality);
}

/**
 * Upload assembled PDF to server, run OCR on specific pages, poll, download.
 */
async function runOcrOnServer(
  pdfBlob: Blob,
  ocrPageIndices: number[],
  fixPageIndices: number[],
  bookName: string,
  onProgress: (progress: PipelineProgress) => void,
  cancelRef: { cancelled: boolean }
): Promise<PipelineResult> {
  const apiBase = '/api/replace-ocr';

  // --- Step 1: Create job ---
  onProgress({ phase: 'preparing', current: 0, total: 0 });

  const createForm = new FormData();
  createForm.append('action', 'create');
  createForm.append('ocrPages', ocrPageIndices.join(','));
  if (fixPageIndices.length > 0) {
    createForm.append('fixPages', fixPageIndices.join(','));
  }

  const createRes = await fetch(apiBase, { method: 'POST', body: createForm });
  if (!createRes.ok) {
    const msg = await createRes.text();
    throw new Error(`Failed to create OCR job: ${msg}`);
  }
  const { jobId } = (await createRes.json()) as { jobId: string };

  if (cancelRef.cancelled) {
    await fetch(`${apiBase}?id=${jobId}`, { method: 'DELETE' }).catch(() => {});
    throw new Error('Cancelled');
  }

  // --- Step 2: Upload in chunks ---
  const totalChunks = Math.ceil(pdfBlob.size / CHUNK_SIZE);

  for (let i = 0; i < totalChunks; i++) {
    if (cancelRef.cancelled) {
      await fetch(`${apiBase}?id=${jobId}`, { method: 'DELETE' }).catch(() => {});
      throw new Error('Cancelled');
    }

    onProgress({ phase: 'preparing', current: i + 1, total: totalChunks });

    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, pdfBlob.size);
    const chunk = pdfBlob.slice(start, end);

    const chunkForm = new FormData();
    chunkForm.append('action', 'chunk');
    chunkForm.append('jobId', jobId);
    chunkForm.append('chunk', chunk);

    const chunkRes = await fetch(apiBase, { method: 'POST', body: chunkForm });
    if (!chunkRes.ok) {
      await fetch(`${apiBase}?id=${jobId}`, { method: 'DELETE' }).catch(() => {});
      const msg = await chunkRes.text();
      throw new Error(`Upload failed: ${msg}`);
    }
  }

  if (cancelRef.cancelled) {
    await fetch(`${apiBase}?id=${jobId}`, { method: 'DELETE' }).catch(() => {});
    throw new Error('Cancelled');
  }

  // --- Step 3: Start processing ---
  const startForm = new FormData();
  startForm.append('action', 'start');
  startForm.append('jobId', jobId);

  const startRes = await fetch(apiBase, { method: 'POST', body: startForm });
  if (!startRes.ok) {
    const msg = await startRes.text();
    throw new Error(`Failed to start OCR: ${msg}`);
  }

  // --- Step 4: Poll for progress ---
  let totalPages = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (cancelRef.cancelled) {
      await fetch(`${apiBase}?id=${jobId}`, { method: 'DELETE' }).catch(() => {});
      throw new Error('Cancelled');
    }

    await new Promise((r) => setTimeout(r, 400));

    const res = await fetch(`${apiBase}?id=${jobId}`);
    if (!res.ok) throw new Error('Failed to check OCR status');
    const status = (await res.json()) as {
      phase: string;
      current: number;
      total: number;
      error?: string;
    };

    if (status.phase === 'error') {
      throw new Error(status.error || 'OCR processing failed');
    }

    if (status.phase === 'done') {
      totalPages = status.total || status.current;
      break;
    }

    totalPages = status.total || 0;
    onProgress({
      phase: (status.phase || 'ocr') as PipelinePhase,
      current: status.current || 0,
      total: totalPages,
    });
  }

  // --- Step 5: Download result via native browser download ---
  onProgress({ phase: 'merging', current: totalPages, total: totalPages });

  const safeName = sanitizeBookName(bookName);
  const downloadUrl = `${apiBase}/download?id=${jobId}&name=${encodeURIComponent(safeName)}`;

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

/**
 * Replace-pages pipeline: swap, delete, or insert pages in a PDF,
 * then reassemble. If replaced/inserted pages exist, run OCR on them
 * server-side so the output remains searchable.
 */
export async function runReplacePipeline(
  file: File,
  replacements: Map<number, File>, // 1-based pageNumber → image File
  deletions: Set<number>,
  insertions: Insertion[],
  pageOrder: number[], // 1-based page numbers in display/output order
  bookName: string,
  onProgress: (progress: PipelineProgress) => void,
  cancelRef: { cancelled: boolean }
): Promise<PipelineResult> {
  const buffer = await file.arrayBuffer();
  const pdfBytes = new Uint8Array(buffer);

  // Get page count and page sizes from source PDF
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const totalPages = pdfDoc.getPageCount();

  // --- Phase: Preparing — convert images to JPEG ---
  onProgress({ phase: 'preparing', current: 0, total: totalPages });

  if (cancelRef.cancelled) throw new Error('Cancelled');

  // Convert replacement files (images or PDFs) to JPEG
  const convertedReplacements = new Map<number, Uint8Array>();
  const pdfReplacementPages = new Set<number>(); // track which replacements are from PDFs
  const replacementEntries = Array.from(replacements.entries());

  for (let i = 0; i < replacementEntries.length; i++) {
    if (cancelRef.cancelled) throw new Error('Cancelled');

    const [pageNum, srcFile] = replacementEntries[i];
    onProgress({
      phase: 'preparing' as PipelinePhase,
      current: i + 1,
      total: replacementEntries.length + insertions.length,
    });

    if (isPdfFile(srcFile)) pdfReplacementPages.add(pageNum);
    const jpegBytes = await fileToJpeg(srcFile, JPEG_QUALITY);
    convertedReplacements.set(pageNum, jpegBytes);
  }

  // Convert insertion files (images or PDFs) to JPEG
  const convertedInsertions = new Map<string, Uint8Array>();
  const pdfInsertionIds = new Set<string>(); // track which insertions are from PDFs

  for (let i = 0; i < insertions.length; i++) {
    if (cancelRef.cancelled) throw new Error('Cancelled');

    const ins = insertions[i];
    onProgress({
      phase: 'preparing' as PipelinePhase,
      current: replacementEntries.length + i + 1,
      total: replacementEntries.length + insertions.length,
    });

    if (isPdfFile(ins.file)) pdfInsertionIds.add(ins.id);
    const jpegBytes = await fileToJpeg(ins.file, JPEG_QUALITY);
    convertedInsertions.set(ins.id, jpegBytes);
  }

  if (cancelRef.cancelled) throw new Error('Cancelled');

  // Helper: get page size for a given original page number (1-based)
  const getPageSize = (pageNum: number) => {
    const page = pdfDoc.getPage(pageNum - 1);
    return page.getSize();
  };

  // Helper: get nearest page size for insertion point
  const getNearestPageSize = (afterPage: number) => {
    if (afterPage > 0 && afterPage <= totalPages) {
      return getPageSize(afterPage);
    }
    if (totalPages > 0) {
      return getPageSize(1);
    }
    return { width: 595, height: 842 }; // A4 fallback
  };

  // Build the assembly plan in output order
  const assemblePages: AssemblePage[] = [];
  const ocrPageIndices: number[] = []; // 1-based output page numbers needing OCR
  const fixPageIndices: number[] = []; // 1-based output page numbers needing dewarp+clean (PDF sources)
  let outputIndex = 0;

  // Insertions before page 1 (afterPage === 0)
  for (const ins of insertions.filter((i) => i.afterPage === 0)) {
    outputIndex++;
    const jpegBytes = convertedInsertions.get(ins.id)!;
    const pageSize = getNearestPageSize(0);
    assemblePages.push({
      kind: 'straightened',
      jpegBytes,
      pageSizePoints: pageSize,
    });
    ocrPageIndices.push(outputIndex);
    if (pdfInsertionIds.has(ins.id)) {
      fixPageIndices.push(outputIndex);
    }
  }

  // Use pageOrder for output sequence (supports page reordering)
  const orderedPages = pageOrder.length === totalPages ? pageOrder : Array.from({ length: totalPages }, (_, i) => i + 1);

  for (const pageNum of orderedPages) {
    // Skip deleted pages
    if (!deletions.has(pageNum)) {
      outputIndex++;

      const replacementJpeg = convertedReplacements.get(pageNum);
      if (replacementJpeg) {
        const { width, height } = getPageSize(pageNum);
        assemblePages.push({
          kind: 'straightened',
          jpegBytes: replacementJpeg,
          pageSizePoints: { width, height },
        });
        ocrPageIndices.push(outputIndex);
        if (pdfReplacementPages.has(pageNum)) {
          fixPageIndices.push(outputIndex);
        }
      } else {
        assemblePages.push({ kind: 'untouched', pdfIndex: 0, pageIndex: pageNum - 1 });
      }
    }

    // Insertions after this page
    for (const ins of insertions.filter((ins) => ins.afterPage === pageNum)) {
      outputIndex++;
      const jpegBytes = convertedInsertions.get(ins.id)!;
      const pageSize = getNearestPageSize(pageNum);
      assemblePages.push({
        kind: 'straightened',
        jpegBytes,
        pageSizePoints: pageSize,
      });
      ocrPageIndices.push(outputIndex);
      if (pdfInsertionIds.has(ins.id)) {
        fixPageIndices.push(outputIndex);
      }
    }
  }

  if (cancelRef.cancelled) throw new Error('Cancelled');

  const outputTotalPages = assemblePages.length;

  // --- Phase: Merging ---
  onProgress({ phase: 'merging', current: 0, total: outputTotalPages });

  const merged = await assemblePdf(
    { pdfs: [pdfBytes], bookTitle: bookName.trim() },
    assemblePages,
    (current, total) => onProgress({ phase: 'merging', current, total }),
    cancelRef
  );

  const safeName = sanitizeBookName(bookName);
  const filename = `${safeName}.pdf`;
  const blob = new Blob([merged.buffer as ArrayBuffer], { type: 'application/pdf' });

  // If no pages need server processing (delete-only), return directly
  if (ocrPageIndices.length === 0 && fixPageIndices.length === 0) {
    return { blob, filename, totalPages: outputTotalPages, angles: [] };
  }

  // Pages need server processing (OCR and/or dewarp+clean)
  return runOcrOnServer(blob, ocrPageIndices, fixPageIndices, bookName, onProgress, cancelRef);
}
