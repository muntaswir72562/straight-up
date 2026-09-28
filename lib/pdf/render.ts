import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PDF_MAGIC_BYTES, PDF_HEADER_READ_SIZE, RENDER_DPI, MAX_RENDER_DIMENSION, DETECT_WIDTH } from '../constants';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';

export type PdfValidation =
  | { valid: true; pageCount: number }
  | { valid: false; error: string };

function hasValidHeader(buffer: ArrayBuffer): boolean {
  const header = new Uint8Array(buffer, 0, Math.min(PDF_HEADER_READ_SIZE, buffer.byteLength));
  for (let offset = 0; offset <= header.length - PDF_MAGIC_BYTES.length; offset++) {
    let match = true;
    for (let j = 0; j < PDF_MAGIC_BYTES.length; j++) {
      if (header[offset + j] !== PDF_MAGIC_BYTES[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/**
 * Validate a PDF file:
 * 1. Check %PDF- header bytes
 * 2. Load with pdfjs-dist to get page count (catches corruption, passwords)
 */
export async function validatePdf(file: File): Promise<PdfValidation> {
  try {
    const buffer = await file.arrayBuffer();

    if (!hasValidHeader(buffer)) {
      return { valid: false, error: "This file isn't a PDF." };
    }

    const pdf = await pdfjsLib.getDocument({
      data: new Uint8Array(buffer),
    }).promise;

    const pageCount = pdf.numPages;
    pdf.destroy();

    if (pageCount === 0) {
      return { valid: false, error: 'This PDF has no pages.' };
    }

    return { valid: true, pageCount };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes('password')) {
      return { valid: false, error: 'This PDF is password-protected.' };
    }
    return { valid: false, error: "This PDF can't be opened." };
  }
}

export interface PageRenderResult {
  imageData: Uint8ClampedArray;
  width: number;
  height: number;
  /** Page size in PDF points (72 points per inch) */
  pageSizePoints: { width: number; height: number };
}

/**
 * Load a PDF document from a File for rendering.
 * Caller must call destroy() when done.
 */
export async function loadPdfDocument(file: File): Promise<PDFDocumentProxy> {
  const buffer = await file.arrayBuffer();
  return pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
}

/**
 * Render a single page of a PDF to pixel data at the target DPI.
 * Returns the RGBA pixel array plus dimensions and original page size.
 */
export async function renderPage(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  dpi: number = RENDER_DPI
): Promise<PageRenderResult> {
  const page = await pdf.getPage(pageNumber);

  // Get page size in points at scale 1
  const viewport1 = page.getViewport({ scale: 1 });
  const pageSizePoints = { width: viewport1.width, height: viewport1.height };

  // Calculate scale for target DPI (PDF default is 72 DPI)
  let scale = dpi / 72;

  // Cap so neither dimension exceeds MAX_RENDER_DIMENSION
  const renderWidth = viewport1.width * scale;
  const renderHeight = viewport1.height * scale;
  const maxDim = Math.max(renderWidth, renderHeight);
  if (maxDim > MAX_RENDER_DIMENSION) {
    scale *= MAX_RENDER_DIMENSION / maxDim;
  }

  const viewport = page.getViewport({ scale });
  const width = Math.round(viewport.width);
  const height = Math.round(viewport.height);

  // Use OffscreenCanvas if available, otherwise regular canvas
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

  const imageData = ctx.getImageData(0, 0, width, height);

  return {
    imageData: imageData.data,
    width,
    height,
    pageSizePoints,
  };
}

/**
 * Render a page at low resolution for fast angle detection only.
 * Targets DETECT_WIDTH (~1000px wide) directly, avoiding the expensive
 * high-DPI render that's only needed for straightening output.
 */
export async function renderPageFast(
  pdf: PDFDocumentProxy,
  pageNumber: number
): Promise<PageRenderResult> {
  const page = await pdf.getPage(pageNumber);

  const viewport1 = page.getViewport({ scale: 1 });
  const pageSizePoints = { width: viewport1.width, height: viewport1.height };

  // Scale so the width equals DETECT_WIDTH (what detectAngle resizes to anyway)
  const scale = DETECT_WIDTH / viewport1.width;

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

  const imageData = ctx.getImageData(0, 0, width, height);

  return {
    imageData: imageData.data,
    width,
    height,
    pageSizePoints,
  };
}
