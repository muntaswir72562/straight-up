import type { PDFDocumentProxy } from 'pdfjs-dist';

/**
 * Render a single PDF page to a small JPEG data URL for thumbnail preview.
 * Uses OffscreenCanvas when available, falls back to DOM canvas.
 */
export async function renderThumbnail(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  maxWidth: number
): Promise<string> {
  const page = await pdf.getPage(pageNumber);
  const viewport1 = page.getViewport({ scale: 1 });

  const scale = maxWidth / viewport1.width;
  const viewport = page.getViewport({ scale });
  const width = Math.round(viewport.width);
  const height = Math.round(viewport.height);

  let canvas: HTMLCanvasElement | OffscreenCanvas;
  let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(width, height);
    ctx = canvas.getContext('2d')!;
  } else {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    ctx = canvas.getContext('2d')!;
  }

  await page.render({ canvasContext: ctx as CanvasRenderingContext2D, viewport }).promise;
  page.cleanup();

  // Export as JPEG data URL (low quality for thumbnails)
  if (canvas instanceof OffscreenCanvas) {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
    return URL.createObjectURL(blob);
  } else {
    return canvas.toDataURL('image/jpeg', 0.6);
  }
}
