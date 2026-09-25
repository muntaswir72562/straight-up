import { PDFDocument } from 'pdf-lib';
import { assemblePdf, type AssemblePage } from './pdf/assemble';
import { sanitizeBookName } from './filename';
import { JPEG_QUALITY, MAX_RENDER_DIMENSION } from './constants';
import type { PipelineResult, PipelinePhase, PipelineProgress } from './pipeline';

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
 * Replace-pages pipeline: swap specific pages with user-provided images,
 * then reassemble the PDF. No deskew/OpenCV needed.
 */
export async function runReplacePipeline(
  file: File,
  replacements: Map<number, File>, // 1-based pageNumber → image File
  bookName: string,
  onProgress: (progress: PipelineProgress) => void,
  cancelRef: { cancelled: boolean }
): Promise<PipelineResult> {
  const buffer = await file.arrayBuffer();
  const pdfBytes = new Uint8Array(buffer);

  // Get page count and page sizes from source PDF
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const totalPages = pdfDoc.getPageCount();

  // --- Phase: Preparing ---
  onProgress({ phase: 'preparing', current: 0, total: totalPages });

  if (cancelRef.cancelled) throw new Error('Cancelled');

  // Build pages array — collect page sizes for replacement pages
  const assemblePages: AssemblePage[] = [];
  const replacementEntries = Array.from(replacements.entries());

  // Convert replacement images to JPEG
  const convertedReplacements = new Map<number, Uint8Array>();

  for (let i = 0; i < replacementEntries.length; i++) {
    if (cancelRef.cancelled) throw new Error('Cancelled');

    const [pageNum, imgFile] = replacementEntries[i];
    onProgress({
      phase: 'preparing' as PipelinePhase,
      current: i + 1,
      total: replacementEntries.length,
    });

    const jpegBytes = await imageFileToJpeg(imgFile, JPEG_QUALITY);
    convertedReplacements.set(pageNum, jpegBytes);
  }

  if (cancelRef.cancelled) throw new Error('Cancelled');

  // Build the assembly plan
  for (let i = 0; i < totalPages; i++) {
    const pageNum = i + 1;
    const jpegBytes = convertedReplacements.get(pageNum);

    if (jpegBytes) {
      const page = pdfDoc.getPage(i);
      const { width, height } = page.getSize();
      assemblePages.push({
        kind: 'straightened',
        jpegBytes,
        pageSizePoints: { width, height },
      });
    } else {
      assemblePages.push({ kind: 'untouched', pdfIndex: 0, pageIndex: i });
    }
  }

  if (cancelRef.cancelled) throw new Error('Cancelled');

  // --- Phase: Merging ---
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

  return { blob, filename, totalPages, angles: [] };
}
