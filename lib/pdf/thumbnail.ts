import type { PDFDocumentProxy } from 'pdfjs-dist';
import { extractPageThumb } from './extractThumb';

// ── Blob Cache ──────────────────────────────────────────────────────
// Stores rendered JPEG blobs keyed by pdf-fingerprint + page + width.
// Each caller gets its own blob URL via URL.createObjectURL, so
// components can freely revoke their URLs without affecting the cache.
const blobCache = new Map<string, Blob>();
const MAX_CACHE = 2000;

function cacheKey(fingerprint: string, pageNumber: number, maxWidth: number): string {
  return `${fingerprint}-${pageNumber}-${maxWidth}`;
}

/** Clear cached thumbnails. Pass a PDF to clear only its entries; omit to clear all. */
export function clearThumbnailCache(pdf?: PDFDocumentProxy): void {
  if (pdf) {
    const prefix = `${pdf.fingerprints[0]}-`;
    for (const key of [...blobCache.keys()]) {
      if (key.startsWith(prefix)) blobCache.delete(key);
    }
  } else {
    blobCache.clear();
  }
}

// ── In-flight deduplication ─────────────────────────────────────────
const inflight = new Map<string, Promise<Blob>>();

// ── Core render ─────────────────────────────────────────────────────
async function renderToBlob(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  maxWidth: number,
): Promise<Blob> {
  const page = await pdf.getPage(pageNumber);
  const vp1 = page.getViewport({ scale: 1 });

  const scale = maxWidth / vp1.width;
  const viewport = page.getViewport({ scale });
  const w = Math.round(viewport.width);
  const h = Math.round(viewport.height);

  const quality = maxWidth <= 80 ? 0.3 : maxWidth <= 200 ? 0.5 : 0.6;

  let canvas: HTMLCanvasElement | OffscreenCanvas;
  let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext('2d')!;
  } else {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    ctx = canvas.getContext('2d')!;
  }

  await page.render({ canvasContext: ctx as CanvasRenderingContext2D, viewport }).promise;
  page.cleanup();

  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: 'image/jpeg', quality });
  }
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
      'image/jpeg',
      quality,
    );
  });
}

/**
 * Render a PDF page to a JPEG blob URL.
 *
 * Results are blob-cached — subsequent calls for the same page skip
 * canvas rendering entirely and create a new URL from the cached blob.
 * Duplicate in-flight renders for the same page are deduplicated.
 */
export async function renderThumbnail(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  maxWidth: number,
): Promise<string> {
  const fp = pdf.fingerprints[0] ?? '';
  const key = cacheKey(fp, pageNumber, maxWidth);

  // 1. Cache hit → instant blob URL (no rendering)
  const cached = blobCache.get(key);
  if (cached) return URL.createObjectURL(cached);

  // 2. Fast path: extract raw JPEG from scanned PDF (bypasses pdfjs JS decoder)
  //    Falls back to null for non-JPEG pages.
  let promise = inflight.get(key);
  if (!promise) {
    promise = extractPageThumb(pageNumber, maxWidth)
      .then((blob) => blob ?? renderToBlob(pdf, pageNumber, maxWidth));
    inflight.set(key, promise);
    promise
      .then((blob) => {
        if (blobCache.size >= MAX_CACHE) {
          const oldest = blobCache.keys().next().value;
          if (oldest !== undefined) blobCache.delete(oldest);
        }
        blobCache.set(key, blob);
      })
      .catch(() => {})
      .finally(() => { inflight.delete(key); });
  }

  const blob = await promise;
  return URL.createObjectURL(blob);
}
