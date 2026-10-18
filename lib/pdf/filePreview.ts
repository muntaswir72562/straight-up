import { THUMBNAIL_WIDTH } from '../constants';

/**
 * Generate a preview blob URL for a File (image or PDF).
 * For images: returns a simple object URL.
 * For PDFs: renders page 1 as a JPEG thumbnail via pdfjs-dist.
 *
 * @param maxWidth  Render width for PDF files (default: THUMBNAIL_WIDTH).
 *                  Pass a larger value (e.g. FULLSCREEN_RENDER_WIDTH) for
 *                  sharp previews in the fullscreen viewer.
 */
export async function renderFilePreview(
  file: File,
  maxWidth: number = THUMBNAIL_WIDTH,
): Promise<string> {
  const isPdf =
    file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

  if (!isPdf) {
    return URL.createObjectURL(file);
  }

  // Dynamic import to avoid loading pdfjs-dist eagerly
  const { loadPdfDocument } = await import('@/lib/pdf/render');
  const { renderThumbnail } = await import('@/lib/pdf/thumbnail');

  const pdf = await loadPdfDocument(file);
  try {
    return await renderThumbnail(pdf, 1, maxWidth);
  } finally {
    pdf.destroy();
  }
}
