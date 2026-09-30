import type { SlotData } from './types';
import { assemblePdf, type AssemblePage } from './pdf/assemble';
import { loadPdfDocument, renderPage, renderPageFast } from './pdf/render';
import { DeskewClient } from './deskew/client';
import { sanitizeBookName } from './filename';
import { SKIP_THRESHOLD, AUTO_CROP } from './constants';

export interface PageAngleInfo {
  slotNumber: number;
  pageIndex: number;
  angle: number;
  method: 'text' | 'edge' | 'none';
  confidence: number;
  straightened: boolean;
}

export interface PipelineResult {
  blob: Blob;
  filename: string;
  totalPages: number;
  angles: PageAngleInfo[];
  downloadUrl?: string;
}

export type PipelinePhase = 'preparing' | 'detecting' | 'straightening' | 'cleaning' | 'dewarping' | 'fixing' | 'merging' | 'saving' | 'ocr';

export interface PipelineProgress {
  phase: PipelinePhase;
  current: number;
  total: number;
}

// Page reference for re-rendering at full resolution later
interface PageRef {
  slotIdx: number;
  pageNumber: number; // 1-based
  pageSizePoints: { width: number; height: number };
}

interface PageToStraighten {
  globalIndex: number;
  angle: number;
  imageData: Uint8ClampedArray;
  width: number;
  height: number;
  pageSizePoints: { width: number; height: number };
}

/**
 * Full pipeline: fast-detect → inherit → full-render + straighten → assemble.
 *
 * Two-pass rendering for speed:
 * - Pass 1: render each page at LOW resolution (~1000px wide) for angle detection
 * - Pass 2: render ONLY pages that need straightening at FULL resolution (200 DPI)
 *
 * Angle inheritance: pages with no edge detection and method='none' inherit the
 * median angle from edge-detected pages. Pages where text detection returned
 * a small angle are left alone (their text is likely already near-straight).
 */
export async function runPipeline(
  slots: SlotData[],
  bookName: string,
  onProgress: (progress: PipelineProgress) => void,
  cancelRef: { cancelled: boolean }
): Promise<PipelineResult> {
  const filledSlots = slots.filter((s) => s.file !== null);

  if (filledSlots.length === 0) {
    throw new Error('No files to merge.');
  }

  const totalPages = filledSlots.reduce((sum, s) => sum + (s.pageCount ?? 0), 0);

  // --- Phase: Preparing ---
  onProgress({ phase: 'preparing', current: 0, total: totalPages });

  const deskew = new DeskewClient();
  try {
    await deskew.init();
    console.log('[pipeline] OpenCV worker ready');
  } catch (err) {
    console.warn('[pipeline] OpenCV failed to load, falling back to plain merge:', err);
    deskew.destroy();
    return runPlainMerge(filledSlots, bookName, totalPages, onProgress, cancelRef);
  }

  if (cancelRef.cancelled) {
    deskew.destroy();
    throw new Error('Cancelled');
  }

  // --- Phase: Detecting (low-res fast render) ---
  const angles: PageAngleInfo[] = [];
  const assemblePages: AssemblePage[] = [];
  const pageRefs: PageRef[] = [];
  let pagesProcessed = 0;
  let pdfIndex = 0;

  for (let slotIdx = 0; slotIdx < filledSlots.length; slotIdx++) {
    if (cancelRef.cancelled) break;
    const slot = filledSlots[slotIdx];

    const pdf = await loadPdfDocument(slot.file!);
    const pageCount = pdf.numPages;

    for (let p = 1; p <= pageCount; p++) {
      if (cancelRef.cancelled) break;

      onProgress({ phase: 'detecting', current: pagesProcessed + 1, total: totalPages });

      try {
        // Fast low-res render for detection only
        const rendered = await renderPageFast(pdf, p);
        const result = await deskew.detectAngle(rendered.imageData, rendered.width, rendered.height);

        const needsStraightening = Math.abs(result.angle) >= SKIP_THRESHOLD;
        console.log(`[pipeline] Page ${pagesProcessed + 1}: angle=${result.angle.toFixed(3)}° method=${result.method} confidence=${result.confidence.toFixed(2)} straighten=${needsStraightening}`);

        angles.push({
          slotNumber: slot.number,
          pageIndex: p,
          angle: result.angle,
          method: result.method,
          confidence: result.confidence,
          straightened: needsStraightening,
        });

        pageRefs.push({ slotIdx, pageNumber: p, pageSizePoints: rendered.pageSizePoints });
      } catch {
        angles.push({
          slotNumber: slot.number,
          pageIndex: p,
          angle: 0,
          method: 'none',
          confidence: 0,
          straightened: false,
        });
        pageRefs.push({ slotIdx, pageNumber: p, pageSizePoints: { width: 612, height: 792 } });
      }

      assemblePages.push({ kind: 'untouched', pdfIndex, pageIndex: p - 1 });
      pagesProcessed++;
    }

    pdf.destroy();
    pdfIndex++;
  }

  if (cancelRef.cancelled) {
    deskew.destroy();
    throw new Error('Cancelled');
  }

  // Pages where detection failed (method='none') are left untouched.
  // Inheriting angles from other pages is unsafe — different pages can sit at
  // different angles in the scanner, so forcing one page's angle onto another
  // causes overcorrection on pages that are already near-straight.

  // --- Phase: Straightening (full-res render only for pages that need it) ---
  const pagesToStraighten = angles
    .map((a, i) => ({ angle: a, index: i }))
    .filter((p) => p.angle.straightened);

  if (pagesToStraighten.length > 0) {
    console.log(`[pipeline] Rendering ${pagesToStraighten.length} pages at full resolution for straightening`);

    for (let i = 0; i < pagesToStraighten.length; i++) {
      if (cancelRef.cancelled) break;

      onProgress({ phase: 'straightening', current: i + 1, total: pagesToStraighten.length });

      const { angle: angleInfo, index: gi } = pagesToStraighten[i];
      const ref = pageRefs[gi];
      const slot = filledSlots[ref.slotIdx];

      try {
        // Full-resolution render for quality straightening output
        const pdf = await loadPdfDocument(slot.file!);
        const rendered = await renderPage(pdf, ref.pageNumber);
        pdf.destroy();

        console.log(`[pipeline] Straightening page ${gi + 1}: angle=${angleInfo.angle.toFixed(3)}° size=${rendered.width}x${rendered.height}`);

        const result = await deskew.straightenPage(
          rendered.imageData, rendered.width, rendered.height, angleInfo.angle, AUTO_CROP
        );

        assemblePages[gi] = {
          kind: 'straightened',
          jpegBytes: result.jpeg,
          pageSizePoints: rendered.pageSizePoints,
        };
        console.log(`[pipeline] Straightened page ${gi + 1}: jpeg=${result.jpeg.length} bytes, ${result.croppedWidth}x${result.croppedHeight}`);
      } catch (err) {
        console.warn(`[pipeline] Straighten failed for page ${gi + 1}:`, err);
        angles[gi].straightened = false;
      }
    }
  }

  deskew.destroy();

  if (cancelRef.cancelled) throw new Error('Cancelled');

  // --- Phase: Merging ---
  const straightenedCount = assemblePages.filter(p => p.kind === 'straightened').length;
  const untouchedCount = assemblePages.filter(p => p.kind === 'untouched').length;
  console.log(`[pipeline] Assembly: ${straightenedCount} straightened, ${untouchedCount} untouched, ${totalPages} total`);
  onProgress({ phase: 'merging', current: 0, total: totalPages });

  const pdfBytesArray: Uint8Array[] = [];
  for (const slot of filledSlots) {
    if (cancelRef.cancelled) throw new Error('Cancelled');
    const buffer = await slot.file!.arrayBuffer();
    pdfBytesArray.push(new Uint8Array(buffer));
  }

  const merged = await assemblePdf(
    { pdfs: pdfBytesArray, bookTitle: bookName.trim() },
    assemblePages,
    (current, total) => onProgress({ phase: 'merging', current, total }),
    cancelRef
  );

  const safeName = sanitizeBookName(bookName);
  const filename = `${safeName}.pdf`;
  const blob = new Blob([merged.buffer as ArrayBuffer], { type: 'application/pdf' });

  return { blob, filename, totalPages, angles };
}

/**
 * Fix-only pipeline: fast-detect → inherit → full-render + straighten → reassemble.
 * Same two-pass approach as runPipeline but for a single PDF.
 */
export async function runFixPipeline(
  file: File,
  bookName: string,
  onProgress: (progress: PipelineProgress) => void,
  cancelRef: { cancelled: boolean }
): Promise<PipelineResult> {
  const buffer = await file.arrayBuffer();
  const pdfBytes = new Uint8Array(buffer);

  const pdfDoc = await loadPdfDocument(file);
  const totalPages = pdfDoc.numPages;
  pdfDoc.destroy();

  // --- Phase: Preparing ---
  onProgress({ phase: 'preparing', current: 0, total: totalPages });

  const deskew = new DeskewClient();
  try {
    await deskew.init();
    console.log('[fix-pipeline] OpenCV worker ready');
  } catch (err) {
    console.warn('[fix-pipeline] OpenCV failed to load:', err);
    deskew.destroy();
    const safeName = sanitizeBookName(bookName);
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    return { blob, filename: `${safeName}.pdf`, totalPages, angles: [] };
  }

  if (cancelRef.cancelled) {
    deskew.destroy();
    throw new Error('Cancelled');
  }

  // --- Phase: Detecting (low-res fast render) ---
  const angles: PageAngleInfo[] = [];
  const assemblePages: AssemblePage[] = [];

  const pdf = await loadPdfDocument(file);

  for (let p = 1; p <= totalPages; p++) {
    if (cancelRef.cancelled) break;

    onProgress({ phase: 'detecting', current: p, total: totalPages });

    try {
      const rendered = await renderPageFast(pdf, p);
      const result = await deskew.detectAngle(rendered.imageData, rendered.width, rendered.height);

      const needsStraightening = Math.abs(result.angle) >= SKIP_THRESHOLD;
      console.log(`[fix-pipeline] Page ${p}: angle=${result.angle.toFixed(3)}° method=${result.method} confidence=${result.confidence.toFixed(2)} straighten=${needsStraightening}`);

      angles.push({
        slotNumber: 1,
        pageIndex: p,
        angle: result.angle,
        method: result.method,
        confidence: result.confidence,
        straightened: needsStraightening,
      });
    } catch {
      angles.push({
        slotNumber: 1,
        pageIndex: p,
        angle: 0,
        method: 'none',
        confidence: 0,
        straightened: false,
      });
    }

    assemblePages.push({ kind: 'untouched', pdfIndex: 0, pageIndex: p - 1 });
  }

  pdf.destroy();

  if (cancelRef.cancelled) {
    deskew.destroy();
    throw new Error('Cancelled');
  }

  // Pages where detection failed (method='none') are left untouched.
  // Inheriting angles from other pages is unsafe — different pages can sit at
  // different angles in the scanner, so forcing one page's angle onto another
  // causes overcorrection on pages that are already near-straight.

  // --- Phase: Straightening (full-res render only for pages that need it) ---
  const pagesToStraighten = angles
    .map((a, i) => ({ angle: a, index: i }))
    .filter((p) => p.angle.straightened);

  if (pagesToStraighten.length > 0) {
    console.log(`[fix-pipeline] Rendering ${pagesToStraighten.length} pages at full resolution for straightening`);
    const pdf2 = await loadPdfDocument(file);

    for (let i = 0; i < pagesToStraighten.length; i++) {
      if (cancelRef.cancelled) break;
      onProgress({ phase: 'straightening', current: i + 1, total: pagesToStraighten.length });

      const { angle: angleInfo, index: gi } = pagesToStraighten[i];

      try {
        const rendered = await renderPage(pdf2, gi + 1);
        console.log(`[fix-pipeline] Straightening page ${gi + 1}: angle=${angleInfo.angle.toFixed(3)}°`);

        const result = await deskew.straightenPage(
          rendered.imageData, rendered.width, rendered.height, angleInfo.angle, AUTO_CROP
        );

        assemblePages[gi] = {
          kind: 'straightened',
          jpegBytes: result.jpeg,
          pageSizePoints: rendered.pageSizePoints,
        };
        console.log(`[fix-pipeline] Straightened page ${gi + 1}: jpeg=${result.jpeg.length} bytes`);
      } catch (err) {
        console.warn(`[fix-pipeline] Straighten failed for page ${gi + 1}:`, err);
        angles[gi].straightened = false;
      }
    }

    pdf2.destroy();
  }

  deskew.destroy();
  if (cancelRef.cancelled) throw new Error('Cancelled');

  // --- Phase: Reassembling ---
  const straightenedCount = assemblePages.filter(p => p.kind === 'straightened').length;
  const untouchedCount = assemblePages.filter(p => p.kind === 'untouched').length;
  console.log(`[fix-pipeline] Assembly: ${straightenedCount} straightened, ${untouchedCount} untouched, ${totalPages} total`);
  onProgress({ phase: 'merging', current: 0, total: totalPages });

  const merged = await assemblePdf(
    { pdfs: [pdfBytes], bookTitle: bookName.trim() },
    assemblePages,
    (current, total) => onProgress({ phase: 'merging', current, total }),
    cancelRef
  );

  const safeName = sanitizeBookName(bookName);
  const filename = `${safeName}.pdf`;
  const blob = new Blob([merged.buffer as ArrayBuffer], { type: 'application/pdf' });

  return { blob, filename, totalPages, angles };
}

/**
 * Merge-only pipeline: merge multiple PDFs with no angle detection or straightening.
 */
export async function runMergeOnlyPipeline(
  slots: SlotData[],
  bookName: string,
  onProgress: (progress: PipelineProgress) => void,
  cancelRef: { cancelled: boolean }
): Promise<PipelineResult> {
  const filledSlots = slots.filter((s) => s.file !== null);

  if (filledSlots.length === 0) {
    throw new Error('No files to merge.');
  }

  const totalPages = filledSlots.reduce((sum, s) => sum + (s.pageCount ?? 0), 0);
  return runPlainMerge(filledSlots, bookName, totalPages, onProgress, cancelRef);
}

/**
 * Fallback: plain merge without angle detection (if OpenCV fails to load).
 */
async function runPlainMerge(
  filledSlots: SlotData[],
  bookName: string,
  totalPages: number,
  onProgress: (progress: PipelineProgress) => void,
  cancelRef: { cancelled: boolean }
): Promise<PipelineResult> {
  onProgress({ phase: 'merging', current: 0, total: totalPages });

  const pdfBytesArray: Uint8Array[] = [];
  for (const slot of filledSlots) {
    if (cancelRef.cancelled) throw new Error('Cancelled');
    const buffer = await slot.file!.arrayBuffer();
    pdfBytesArray.push(new Uint8Array(buffer));
  }

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

  const safeName = sanitizeBookName(bookName);
  const filename = `${safeName}.pdf`;
  const blob = new Blob([merged.buffer as ArrayBuffer], { type: 'application/pdf' });

  return { blob, filename, totalPages, angles: [] };
}
