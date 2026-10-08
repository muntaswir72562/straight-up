import { PDFDocument, PDFName, PDFDict, PDFRawStream, PDFArray } from 'pdf-lib';

// ── Module-level cache ──────────────────────────────────────────────
// Keeps the parsed pdf-lib document so we only parse once per file.
let cachedDoc: PDFDocument | null = null;
let cachedFingerprint: string | null = null;

/**
 * Parse a PDF with pdf-lib for fast JPEG extraction.
 * Call once after the file is validated; subsequent `extractPageThumb`
 * calls reuse the parsed document.
 *
 * @param fingerprint  The pdfjs fingerprint so extraction is only
 *                     attempted for the matching document.
 */
export async function loadForExtraction(bytes: Uint8Array, fingerprint: string): Promise<void> {
  cachedDoc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  cachedFingerprint = fingerprint;
}

/** Release the cached pdf-lib document. */
export function clearExtraction(): void {
  cachedDoc = null;
  cachedFingerprint = null;
}

/**
 * Try to extract the raw JPEG bytes for a page and resize via the
 * browser's native `createImageBitmap` decoder (off main thread,
 * hardware-accelerated).
 *
 * Returns a resized JPEG Blob on success, or `null` if the page
 * doesn't contain a simple embedded JPEG (falls back to pdfjs).
 */
export async function extractPageThumb(
  fingerprint: string,
  pageNumber: number,
  maxWidth: number,
): Promise<Blob | null> {
  if (!cachedDoc || cachedFingerprint !== fingerprint) return null;

  try {
    const page = cachedDoc.getPage(pageNumber - 1);
    const ctx = cachedDoc.context;

    // Resolve Resources (may be a direct dict or an indirect ref)
    const resourcesRef = page.node.get(PDFName.of('Resources'));
    if (!resourcesRef) return null;
    const resources = ctx.lookup(resourcesRef);
    if (!(resources instanceof PDFDict)) return null;

    // Resolve XObject sub-dictionary
    const xobjectsRef = resources.get(PDFName.of('XObject'));
    if (!xobjectsRef) return null;
    const xobjects = ctx.lookup(xobjectsRef);
    if (!(xobjects instanceof PDFDict)) return null;

    // Find the first image with DCTDecode (JPEG) filter
    let jpegBytes: Uint8Array | null = null;

    for (const [, value] of xobjects.entries()) {
      const obj = ctx.lookup(value);
      if (!(obj instanceof PDFRawStream)) continue;

      const dict = obj.dict;

      // Must be an Image subtype
      const subtype = dict.get(PDFName.of('Subtype'));
      if (!subtype || subtype.toString() !== '/Image') continue;

      // Check filter is DCTDecode (plain or single-element array)
      const filter = dict.get(PDFName.of('Filter'));
      if (!filter) continue;

      const filterStr = filter.toString();
      const isDCT =
        filterStr === '/DCTDecode' ||
        (filter instanceof PDFArray &&
          filter.size() === 1 &&
          filter.get(0).toString() === '/DCTDecode');

      if (isDCT) {
        jpegBytes = obj.contents;
        break;
      }
    }

    if (!jpegBytes || jpegBytes.length < 100) return null;

    // Native browser decode — runs off main thread, uses hardware JPEG decoder
    const blob = new Blob([jpegBytes as BlobPart], { type: 'image/jpeg' });
    const bitmap = await createImageBitmap(blob, {
      resizeWidth: maxWidth,
      resizeQuality: 'medium',
    });

    // Re-encode as a smaller JPEG thumbnail
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const canvasCtx = canvas.getContext('2d')!;
    canvasCtx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const quality = maxWidth <= 80 ? 0.3 : maxWidth <= 200 ? 0.5 : 0.6;
    return canvas.convertToBlob({ type: 'image/jpeg', quality });
  } catch {
    return null;
  }
}
