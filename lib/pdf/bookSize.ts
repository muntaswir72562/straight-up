/**
 * Same page size for the whole book.
 *
 * Photographed books come out with every page a slightly different size, and
 * some pages much smaller (taken from further away). A page is brought to the
 * book size by scaling it evenly until it fills the book page, with the
 * overflow trimmed from the edges: no white space is added and letters keep
 * their shape.
 *
 * The trim never cuts into what is printed: the page's content (text, rules,
 * stamps, pictures, even faint print; not plain borders, and not marks
 * touching the photo's edge or lying in a thin strip along it) must stay
 * inside the trimmed page; the cut may sit off-centre to stay in the margin.
 * When there is not enough margin, nothing is cut: a page within 2 % of the
 * book's shape is stretched to it (invisible); any other page is scaled to
 * fit inside the book size and stays a little narrower or shorter.
 * A landscape page in a portrait book gets the book size turned.
 *
 * Same rule as resize_to_book in scripts/fullfix_pdf.py (Full Book Fix).
 */

export interface Size {
  width: number;
  height: number;
}

/** Content box as 0..1 fractions of the image: [x0, y0, x1, y1] */
export type ContentBox = [number, number, number, number];

export const BOOK_SIZE_MAX_TRIM = 0.15; // most a page may lose, across one dimension
export const BOOK_SIZE_MAX_STRETCH = 0.02; // shape this close to the book's: stretched when it can't be trimmed
const CONTENT_WIDTH_PX = 270; // images are looked at this wide to find their content
const CONTENT_CONTRAST = 48; // 3x3 grey range that counts as content (pictures)
const CONTENT_INK = 200; // darker than this, against the paper (255), counts as print
const CONTENT_MIN_AREA = 8; // px: smaller marks are specks (photo noise)
const CONTENT_EDGE = 0.015; // marks entirely in this strip along an edge are ignored
const CONTENT_PAD = 0.01; // keep this share of the page clear around the content

function median(sorted: number[]): number {
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/** The book's page size: the median short and long side of its pages,
 *  upright or across as most pages are. */
export function bookPageSize(sizes: Size[]): Size | null {
  if (sizes.length === 0) return null;
  const short = sizes.map((s) => Math.min(s.width, s.height)).sort((a, b) => a - b);
  const long = sizes.map((s) => Math.max(s.width, s.height)).sort((a, b) => a - b);
  const across = sizes.filter((s) => s.width > s.height).length > sizes.length / 2;
  const s = median(short);
  const l = median(long);
  return across ? { width: l, height: s } : { width: s, height: l };
}

// ── Content detection (on a small grey image) ───────────────────────────

/** Max (or min) over a k x k square; pixels outside the image are ignored. */
function rankSquare(src: Uint8Array, w: number, h: number, k: number, max: boolean): Uint8Array {
  const r = k >> 1;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = max ? 0 : 255;
      for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) {
        const p = src[y * w + i];
        v = max ? (p > v ? p : v) : p < v ? p : v;
      }
      tmp[y * w + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = max ? 0 : 255;
      for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++) {
        const p = tmp[j * w + x];
        v = max ? (p > v ? p : v) : p < v ? p : v;
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** k x k median with edge pixels repeated (as OpenCV's medianBlur). */
function medianSquare(src: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const r = k >> 1;
  const half = (k * k) >> 1;
  const out = new Uint8Array(w * h);
  const hist = new Int32Array(256);
  const at = (x: number, y: number) =>
    src[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    hist.fill(0);
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) hist[at(i, y + j)]++;
    for (let x = 0; x < w; x++) {
      if (x > 0) {
        for (let j = -r; j <= r; j++) {
          hist[at(x - r - 1, y + j)]--;
          hist[at(x + r, y + j)]++;
        }
      }
      let c = 0;
      let v = 0;
      while (v < 255 && c + hist[v] <= half) c += hist[v++];
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * Box around the printed content of a small grey image (0..1 fractions), or
 * null for a page with nothing on it. Content is anything clearly darker
 * than the paper around it (after evening out the paper shading, so faint
 * print counts too) or with real contrast (pictures). Marks touching the
 * image's edge (the photo's edge, the book's edge, the table, shadows) and
 * marks lying entirely in a thin strip along an edge are ignored.
 */
export function contentBox(gray: Uint8Array, w: number, h: number): ContentBox | null {
  const bg = medianSquare(rankSquare(gray, w, h, 9, true), w, h, 15);
  const hi = rankSquare(gray, w, h, 3, true);
  const lo = rankSquare(gray, w, h, 3, false);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const norm = bg[i] ? Math.min(255, Math.round((gray[i] * 255) / bg[i])) : 0;
    mask[i] = norm < CONTENT_INK || hi[i] - lo[i] > CONTENT_CONTRAST ? 1 : 0;
  }
  const band = Math.max(2, Math.round(CONTENT_EDGE * w));
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue;
    // one mark (8-connected)
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    let area = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % w;
      const py = (p - px) / w;
      area++;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
    }
    const xe = x1 + 1;
    const ye = y1 + 1;
    if (area < CONTENT_MIN_AREA) continue; // a speck
    if (x0 <= 0 || y0 <= 0 || xe >= w || ye >= h) continue; // touches the photo's edge
    if (xe <= band || x0 >= w - band || ye <= band || y0 >= h - band) continue; // edge strip
    bx0 = Math.min(bx0, x0);
    by0 = Math.min(by0, y0);
    bx1 = Math.max(bx1, xe);
    by1 = Math.max(by1, ye);
  }
  if (bx1 < 0) return null;
  return [bx0 / w, by0 / h, bx1 / w, by1 / h];
}

/** Content box of a JPEG (browser only: decodes it small on a canvas). */
export async function imageContentBox(jpegBytes: Uint8Array): Promise<ContentBox | null> {
  const bitmap = await createImageBitmap(new Blob([jpegBytes as BlobPart], { type: 'image/jpeg' }));
  try {
    const w = CONTENT_WIDTH_PX;
    const h = Math.max(1, Math.round((bitmap.height * w) / bitmap.width));
    const canvas: OffscreenCanvas | HTMLCanvasElement =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      gray[i] = Math.round(0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2]);
    }
    return contentBox(gray, w, h);
  } finally {
    bitmap.close();
  }
}

// ── Fitting a page to the book size ─────────────────────────────────────

export interface BookFit {
  /** Page size to use, in points */
  page: Size;
  /** Where to draw the whole image (PDF coordinates, origin bottom-left);
   *  parts outside the page are trimmed */
  draw: { x: number; y: number; width: number; height: number };
}

/** Start of a window on [0, length] that holds [lo, hi], as near the centre
 *  as possible; null if it can't hold it. */
function place(length: number, window: number, lo: number, hi: number): number | null {
  const a = Math.max(0, hi - window);
  const b = Math.min(length - window, lo);
  if (a > b + 1e-6) return null;
  return Math.min(Math.max((length - window) / 2, a), b);
}

/**
 * How an image of imgW x imgH pixels fills a page of the book size.
 * content: the image's printed content (see contentBox); null = nothing on it.
 */
export function fitToBook(imgW: number, imgH: number, book: Size, content: ContentBox | null): BookFit {
  let bw = book.width;
  let bh = book.height;
  if (imgW > imgH !== bw > bh) [bw, bh] = [bh, bw]; // landscape page: book turned
  const pad = CONTENT_PAD;
  // the part of the image (pixels) shown on the page: [x0, y0, x1, y1]
  let clip: [number, number, number, number] | null = null;
  let page: Size = { width: bw, height: bh };
  if (imgW / imgH > bw / bh) {
    // wider: trim left and right
    const cw = (imgH * bw) / bh;
    let start: number | null = null;
    if (1 - cw / imgW <= BOOK_SIZE_MAX_TRIM) {
      const [lo, hi] = content ? [(content[0] - pad) * imgW, (content[2] + pad) * imgW] : [imgW / 2, imgW / 2];
      start = place(imgW, cw, lo, hi);
    }
    if (start !== null) clip = [start, 0, start + cw, imgH];
    else if (1 - cw / imgW <= BOOK_SIZE_MAX_STRETCH) clip = [0, 0, imgW, imgH]; // tiny stretch
    else page = { width: bw, height: (bw * imgH) / imgW }; // fit inside
  } else {
    // taller: trim top and bottom
    const ch = (imgW * bh) / bw;
    let start: number | null = null;
    if (1 - ch / imgH <= BOOK_SIZE_MAX_TRIM) {
      const [lo, hi] = content ? [(content[1] - pad) * imgH, (content[3] + pad) * imgH] : [imgH / 2, imgH / 2];
      start = place(imgH, ch, lo, hi);
    }
    if (start !== null) clip = [0, start, imgW, start + ch];
    else if (1 - ch / imgH <= BOOK_SIZE_MAX_STRETCH) clip = [0, 0, imgW, imgH]; // tiny stretch
    else page = { width: (bh * imgW) / imgH, height: bh }; // fit inside
  }
  if (!clip) {
    return { page, draw: { x: 0, y: 0, width: page.width, height: page.height } };
  }
  const sx = page.width / (clip[2] - clip[0]);
  const sy = page.height / (clip[3] - clip[1]);
  return {
    page,
    draw: { x: -clip[0] * sx, y: -(imgH - clip[3]) * sy, width: imgW * sx, height: imgH * sy },
  };
}
