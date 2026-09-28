# Implementation Plan: Book Scan Straightener & Merger

A single-page Next.js web app. A non-technical user types the book name, drops scanned PDF chunks into numbered slots, presses **Start**, and downloads one merged PDF where every page has been automatically straightened (deskewed).

All processing happens **in the browser**. No file is ever uploaded to a server. The app is deployed to Vercel as a static site.

> **Instructions for Claude Code:** implement this plan phase by phase (Section 10). After each phase, stop, summarize what was built, and wait for me to test before continuing. Keep the UI simple — the end user is not technical.

---

## 1. Goals and non-goals

**Goals**
- Merge multiple PDF chunks into one PDF, in the order of the numbered slots.
- Automatically correct small rotations (typically ±0.2° to ±10°) caused by the book being placed crooked on the scanner glass.
- Optionally crop away the dark scanner background around the page after straightening.
- Name the downloaded file after the book.
- Be foolproof for a non-IT user: one screen, no settings to understand.

**Non-goals**
- No dewarping of curved text near the spine.
- No perspective correction for phone photos.
- No OCR (possible future addition).
- No accounts, no server, no database, no uploads.

---

## 2. Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Framework | Next.js (App Router), TypeScript | Static export (`output: 'export'`) |
| Styling | Tailwind CSS | Default from create-next-app |
| PDF rendering | `pdfjs-dist` | Renders pages to images; runs its own worker |
| Image processing | OpenCV.js (official build) | Self-hosted in `/public`, loaded inside a Web Worker |
| PDF writing / merging | `pdf-lib` | Builds the output PDF, embeds JPEGs, copies untouched pages |
| Hosting | Vercel (free Hobby plan) | Static files only, no serverless functions |

Target browsers: current Chrome and Edge (primary). Firefox should work but is secondary.

---

## 3. User interface (single screen)

### 3.1 Layout, top to bottom
1. **Title** — e.g. "Book Scan Merger".
2. **Book name field** — label "Book name". Required. Placeholder e.g. "e.g. Criminal Law of Mauritius".
3. **Slot grid** — square drop zones labeled **1, 2, 3, 4, 5** by default, laid out in a responsive grid.
4. **"Add more" button** — appends 5 new slots (6–10, 11–15, …). *(Make the number added per click a single constant so it can be changed to 1 easily.)*
5. **Start button** — large, primary. Disabled until the book name is filled and at least one slot contains a file.
6. **Progress panel** — appears after Start.
7. **Result panel** — appears when done, with a large **Download** button and page thumbnails.

### 3.2 Slot behaviour
- **Empty slot:** shows its number large and the hint "Drop PDF here or click". Clicking opens the native file picker (PDF only).
- **Drag over:** clear visual highlight.
- **Filled slot:** shows its number, the file name (truncated with full name on hover), and the page count. A small **×** button clears the slot.
- **Drop onto a filled slot:** replaces its file.
- **Multiple files dropped onto one slot:** put the first file in that slot, and the rest into the following empty slots in order, automatically creating new slots if needed. Files are placed in the order the browser provides them, sorted by file name using natural sort (so "2" comes before "10").
- **Non-PDF file:** reject with a friendly inline message on that slot ("This file isn't a PDF").
- **Invalid, corrupted, or password-protected PDF:** friendly message ("This PDF can't be opened").
- **Empty slots between filled ones:** allowed. They are skipped when merging. Before starting, show a gentle confirmation: "Slot 3 is empty. Continue anyway?"
- Slots are **locked** (no edits) while processing runs.

### 3.3 Progress panel
- Overall progress bar with text such as "Straightening page 34 of 120…".
- A note: "Please keep this tab open until it finishes."
- Register a `beforeunload` warning while processing is running.
- A **Cancel** button that stops processing cleanly.

### 3.4 Result panel
- Large **Download** button.
- File name = sanitized book name + `.pdf` (see Section 7).
- Summary line: e.g. "120 pages · 98 straightened · 22 already straight".
- Thumbnail grid of all output pages (phase 5). Each thumbnail shows the angle that was corrected.
- **"Fix a page"** (phase 5): clicking a thumbnail opens a dialog with a before/after preview and an angle slider (−10° to +10°, step 0.1°), plus "Reset to auto" and "Apply". Applying re-processes only that page and rebuilds the output.
- **"Start over"** button that clears everything.

### 3.5 Tone and accessibility
- Plain language everywhere; no technical terms like "deskew", "DPI", "JPEG".
- Large click targets, keyboard accessible slots (Enter/Space opens picker), visible focus states, sufficient contrast.

---

## 4. Architecture

### 4.1 Rendering model
- The tool is a client component, loaded with server-side rendering disabled (dynamic import with `ssr: false`), because PDF.js and OpenCV need browser APIs.
- The app uses static export, so there are no API routes. **PDF files must never be sent to any server.**

### 4.2 Threads
- **Main thread:** UI, PDF.js page rendering (PDF.js uses its own worker for parsing), pdf-lib assembly, download.
- **Deskew Web Worker:** loads OpenCV.js once, receives a page image, returns the detected angle and the straightened page as an encoded JPEG.
  - Use a **classic worker** (not a module worker) so OpenCV.js can be loaded with `importScripts` from `/opencv/opencv.js`.
  - Wait for OpenCV's runtime to be fully initialized before accepting work (the official build signals readiness asynchronously; handle both the "cv is a promise" and "onRuntimeInitialized" variants).
  - The worker posts a "ready" message; the UI shows "Preparing…" until then (first load downloads ~10 MB).
- Transfer image data between threads using transferable objects (ArrayBuffer / ImageBitmap) to avoid copies.

### 4.3 Suggested folder structure
```
/app
  page.tsx                 → renders the tool (dynamic, ssr: false)
  layout.tsx
/components
  BookNameInput.tsx
  SlotGrid.tsx
  Slot.tsx
  ProgressPanel.tsx
  ResultPanel.tsx
  PageThumbnailGrid.tsx    (phase 5)
  FixPageDialog.tsx        (phase 5)
/lib
  pdf/render.ts            → PDF.js setup + render page to image
  pdf/assemble.ts          → pdf-lib output building
  deskew/client.ts         → wrapper around the worker (promise-based API)
  pipeline.ts              → orchestrates slot → pages → deskew → assemble
  filename.ts              → sanitize book name
  naturalSort.ts
  constants.ts             → all tunable numbers (Section 8)
  types.ts
/public
  /opencv/opencv.js
  /pdfjs/pdf.worker.min.mjs
  /workers/deskew.worker.js
```

### 4.4 State model (in React state or a small store)
- `bookName: string`
- `slots: Slot[]` — each with `id`, `number`, `file | null`, `pageCount | null`, `error | null`
- `status: 'idle' | 'preparing' | 'processing' | 'done' | 'cancelled' | 'error'`
- `progress: { current, total }`
- `pages: OutputPage[]` — each with source slot, source page index, original page size (points), detected angle, applied angle, whether it was left untouched, thumbnail URL, and the JPEG bytes (or a reference to the original page if untouched)
- `outputBlob: Blob | null`

---

## 5. Processing pipeline

For each filled slot in slot-number order, for each page in that PDF:

1. **Render (main thread, PDF.js)**
   - Get the page's size in PDF points (scale 1 viewport) — this will be the output page size.
   - Render the page at the target resolution (Section 8, ~200 DPI, capped at a max pixel dimension).
   - Hand the image to the worker.

2. **Detect angle (worker, OpenCV)** — see Section 6.

3. **Decide**
   - If `|angle| < SKIP_THRESHOLD` (0.2°) → mark page **untouched**. The original page will be copied into the output as-is, preserving its original quality and size. (No crop is applied to untouched pages.)
   - Otherwise → rotate and continue.

4. **Straighten (worker)**
   - Rotate the full-resolution image around its centre by the correcting angle, keeping the same canvas size, with **white** fill for the exposed corners.
   - Optional auto-crop (Section 6.4).
   - Encode as JPEG at quality 0.85 (use OffscreenCanvas `convertToBlob` in the worker).
   - Return the JPEG bytes and a small thumbnail.

5. **Release memory**
   - Delete every OpenCV Mat as soon as it is no longer needed (OpenCV.js does **not** garbage-collect Mats — this is the most likely cause of crashes on long books).
   - Call PDF.js `page.cleanup()` after rendering; clear canvases.
   - Process **one page at a time** (a small pipeline of 2 pages in flight is acceptable if it is clearly faster, but start with 1).

6. **Assemble (main thread, pdf-lib)** — after all pages are processed:
   - Create a new PDF document.
   - For untouched pages: copy the original page from its source PDF (load each source PDF into pdf-lib once, lazily).
   - For straightened pages: add a page with the **original page size in points** and draw the JPEG to fill it exactly.
   - Save to bytes → Blob → object URL for the Download button.
   - Set basic document metadata: Title = book name.

7. **Cancel:** checks a cancellation flag between pages; stops cleanly and returns to an editable state.

8. **Errors on a single page:** if detection or rotation fails for a page, fall back to copying the original page untouched, record a warning, and continue. Never fail the whole book because of one page. Show a count of warnings in the result summary.

---

## 6. Deskew algorithm (inside the worker)

The book was placed crooked on the glass, so the page and its text are rotated together by one small angle. The goal is to measure that angle reliably.

### 6.1 Preparation (on a downscaled copy)
- Downscale the page so its width is ~1000 px (`DETECT_WIDTH`). All detection happens on this small copy; the measured angle is then applied to the full-resolution image.
- Convert to grayscale.
- **Find the page region:** threshold (Otsu) to separate the bright page from the dark scanner background, find the largest bright contour. This is important — the dark wedge-shaped borders from a crooked scan must not influence the text-line measurement.
- Build a **text mask** inside the page region: inverted adaptive/Otsu threshold so text is white on black, then shrink the page region inward by a small margin (~3% of width) to exclude page edges, shadows and the spine shadow.

### 6.2 Primary method: projection profile (text lines)
- For each candidate angle, rotate the text mask and compute the sum of white pixels per row.
- Score = sum of squared differences between adjacent row sums (sharp alternation between text lines and gaps means lines are horizontal).
- **Coarse search:** −10° to +10° in 0.5° steps.
- **Fine search:** ±0.5° around the best coarse angle in 0.05° steps.
- **Confidence:** compare the best score to the median score across all angles. If the ratio is below `MIN_CONFIDENCE`, or the page has too few text pixels (`MIN_TEXT_PIXEL_RATIO`), treat the text result as unreliable.

### 6.3 Fallback method: page edge
- Use the minimum-area rotated rectangle of the page contour from 6.1.
- Normalize its angle to the range −45°..+45° and use it if within the search range.
- Used when the text method is unreliable (e.g. title pages, mostly blank pages, pages dominated by images).

### 6.4 Auto-crop (default ON, constant to disable)
- After rotating the full-resolution image, find the page region again (bright area) and crop to its bounding rectangle plus a small margin.
- **Safety:** skip cropping if the detected page area is less than 50% or more than 99% of the image, or if the crop would change the aspect ratio by more than ~15%. When in doubt, don't crop.
- After cropping, the image is still drawn to fill the original page size in the output PDF. If the crop changes the aspect ratio noticeably, instead centre it on a white page of the original size without stretching. **Never distort the page.**

### 6.5 Output of the worker per page
- `angle` (degrees, positive = counter-clockwise correction — document the convention in code)
- `method` ('text' | 'edge' | 'none')
- `confidence`
- `jpeg` bytes (if rotated)
- `thumbnail` bytes (small JPEG, ~200 px wide)

---

## 7. File name handling
- Trim the book name, collapse repeated spaces.
- Remove characters not allowed in file names: `/ \ : * ? " < > |` and control characters.
- Limit length to ~150 characters.
- If the result is empty, use `merged-book`.
- Append `.pdf`.

---

## 8. Tunable constants (all in `lib/constants.ts`)

| Constant | Starting value | Purpose |
|---|---|---|
| `SLOTS_DEFAULT` | 5 | Slots shown initially |
| `SLOTS_ADD_STEP` | 5 | Slots added per "Add more" click |
| `RENDER_DPI` | 200 | Output page resolution |
| `MAX_RENDER_DIMENSION` | 3500 px | Cap to protect memory |
| `DETECT_WIDTH` | 1000 px | Size used for angle detection |
| `MAX_ANGLE` | 10° | Search range ± |
| `COARSE_STEP` / `FINE_STEP` | 0.5° / 0.05° | Search steps |
| `SKIP_THRESHOLD` | 0.2° | Below this, keep original page |
| `MIN_CONFIDENCE` | tune during testing | Text method reliability |
| `MIN_TEXT_PIXEL_RATIO` | tune during testing | Too little text → fallback |
| `JPEG_QUALITY` | 0.85 | Output quality |
| `AUTO_CROP` | true | Crop scanner background |

---

## 9. Library setup notes (common pitfalls)

- **PDF.js worker:** copy the worker file from the installed `pdfjs-dist` package into `/public/pdfjs/` and point PDF.js's worker source to it. The worker file must be the **same version** as the installed package. Add an npm script (e.g. run on `postinstall`) that copies it automatically so versions never drift.
- **OpenCV.js:** download the official prebuilt `opencv.js` (4.x, WebAssembly embedded) into `/public/opencv/`. Do not install it via an npm wrapper that bundles it into the app bundle — it must load only inside the worker.
- **Static export and headers:** with `output: 'export'`, `headers()` in `next.config` is **not** applied. Set long-lived cache headers for `/opencv/*` and `/pdfjs/*` in a `vercel.json` instead.
- **SSR:** any module importing PDF.js, pdf-lib or touching `window`/`Worker` must only load on the client.
- **Memory:** delete OpenCV Mats, revoke object URLs for thumbnails when starting over, and don't keep full-resolution canvases around.

---

## 10. Build phases

Stop after each phase for testing.

**Phase 1 — UI shell (no processing)**
- Book name field, slot grid (5 slots), Add more, click-to-browse, drag-and-drop, multi-file drop filling following slots, replace, clear, PDF validation (check `%PDF` header bytes), page count display (via PDF.js), Start button enable/disable, empty-slot confirmation.
- *Done when:* I can fill slots in any way described in 3.2 and see correct file names and page counts.

**Phase 2 — Plain merge**
- Merge the slot PDFs in order with pdf-lib (no rotation), with progress, cancel, `beforeunload` warning, and download using the sanitized book name.
- *Done when:* I can drop several chunks and download a correctly ordered, correctly named merged PDF.

**Phase 3 — Angle detection**
- Worker with OpenCV loaded, "Preparing…" state, rendering pages with PDF.js, detecting angles (Section 6.1–6.3). For now, only display the detected angle per page in a list; still output the plain merge.
- *Done when:* detected angles look right on my real scans.

**Phase 4 — Straighten and assemble**
- Rotation, white fill, auto-crop, JPEG encoding, untouched-page copying, final assembly, per-page error fallback, result summary.
- *Done when:* the downloaded PDF has straight pages, sensible file size, correct page sizes, and no crashes on a 150+ page book.

**Phase 5 — Preview and manual fix**
- Thumbnail grid with angles, "Fix a page" dialog with before/after and slider, re-processing a single page, rebuilding the output.
- *Done when:* I can correct any page the auto-detection got wrong.

**Phase 6 — Polish and deploy**
- Friendly copy, accessibility pass, responsive layout, `vercel.json` cache headers, static export build, deploy to Vercel, test the live URL in Chrome.

---

## 11. Testing

**Automated (angle detection)**
- Generate synthetic test pages: a page of text lines rendered on white, placed on a dark background, rotated by known angles (e.g. −7°, −3°, −1°, −0.3°, 0°, 0.5°, 2°, 5°, 9°). Detection must be within **±0.2°** of the true angle.
- Include a mostly blank page with only a title to exercise the edge fallback.
- Filename sanitizer and natural sort unit tests.

**Manual (real scans)**
- Test with the actual scanned book chunks.
- Pages with a large table, a mostly empty page, a chapter title page, and a page with footnotes.
- A long run (150–300 pages) while watching memory in Chrome's Task Manager — memory should stay roughly flat, not keep climbing.
- Empty slots in the middle, replacing a slot, cancelling mid-way then starting again.
- Book names with colons, slashes and accents.

---

## 12. Acceptance criteria
- A non-technical user can: type a book name, fill numbered slots (drag or click), add more slots, press Start, and download — with no other decisions required.
- Page order in the output exactly matches slot order, then page order within each file.
- Pages placed crooked on the scanner come out visibly straight; already-straight pages are unchanged.
- The downloaded file is named after the book.
- No file ever leaves the browser.
- A 200-page book processes without the tab crashing in Chrome.
- The app runs from a Vercel URL with nothing to install.
