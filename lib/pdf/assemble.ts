import { PDFDocument } from 'pdf-lib';

export interface AssembleInput {
  /** Ordered list of PDF file bytes to merge */
  pdfs: Uint8Array[];
  /** Book name for document metadata */
  bookTitle: string;
}

/**
 * A page that was left untouched (angle below threshold).
 * Will be copied directly from the source PDF.
 */
export interface UntouchedPage {
  kind: 'untouched';
  /** Index into the AssembleInput.pdfs array */
  pdfIndex: number;
  /** 0-based page index within that PDF */
  pageIndex: number;
}

/**
 * A page that was straightened. The JPEG bytes replace the original page
 * and are embedded at the original page size in points.
 */
export interface StraightenedPage {
  kind: 'straightened';
  jpegBytes: Uint8Array;
  /** Original page size in PDF points (72pt = 1 inch) */
  pageSizePoints: { width: number; height: number };
}

export type AssemblePage = UntouchedPage | StraightenedPage;

/**
 * Assemble a final PDF from a mix of untouched and straightened pages.
 *
 * - Untouched pages are copied directly from the source PDF (no quality loss).
 * - Straightened pages are embedded as full-page JPEG images, sized to the
 *   original page dimensions (centered if the aspect ratio changed from crop).
 */
export async function assemblePdf(
  input: AssembleInput,
  pages: AssemblePage[],
  onProgress: (current: number, total: number) => void,
  cancelRef: { cancelled: boolean }
): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  output.setTitle(input.bookTitle);

  // Load all source PDFs upfront so we can copy pages from any of them
  const sources: PDFDocument[] = [];
  for (const pdfBytes of input.pdfs) {
    const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    sources.push(doc);
  }

  const totalPages = pages.length;
  onProgress(0, totalPages);

  for (let i = 0; i < pages.length; i++) {
    if (cancelRef.cancelled) throw new Error('Cancelled');

    const page = pages[i];

    if (page.kind === 'untouched') {
      const source = sources[page.pdfIndex];
      const [copiedPage] = await output.copyPages(source, [page.pageIndex]);
      output.addPage(copiedPage);
    } else {
      // Embed JPEG and create a page at the original size
      const jpegImage = await output.embedJpg(page.jpegBytes);
      const { width: pageW, height: pageH } = page.pageSizePoints;

      const pdfPage = output.addPage([pageW, pageH]);

      // Scale the image to fit the page while maintaining aspect ratio
      const imgAspect = jpegImage.width / jpegImage.height;
      const pageAspect = pageW / pageH;

      let drawW: number;
      let drawH: number;

      if (imgAspect > pageAspect) {
        // Image is wider relative to page — fit to width
        drawW = pageW;
        drawH = pageW / imgAspect;
      } else {
        // Image is taller relative to page — fit to height
        drawH = pageH;
        drawW = pageH * imgAspect;
      }

      // Center the image on the page
      const x = (pageW - drawW) / 2;
      const y = (pageH - drawH) / 2;

      pdfPage.drawImage(jpegImage, { x, y, width: drawW, height: drawH });
    }

    onProgress(i + 1, totalPages);
  }

  if (cancelRef.cancelled) throw new Error('Cancelled');

  const bytes = await output.save();
  return new Uint8Array(bytes);
}
