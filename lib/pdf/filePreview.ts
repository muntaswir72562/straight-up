import { THUMBNAIL_WIDTH } from '../constants';

/**
 * Generate a preview blob URL for a File (image or PDF).
 * For images: returns a simple object URL.
 * For PDFs: renders page 1 as a JPEG thumbnail via pdfjs-dist.
 */
export async function renderFilePreview(file: File): Promise<string> {
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
    return await renderThumbnail(pdf, 1, THUMBNAIL_WIDTH);
  } finally {
    pdf.destroy();
  }
}
