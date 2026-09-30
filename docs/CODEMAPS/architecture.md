# System Architecture Codemap

<!-- Generated: 2026-09-30 | Files scanned: 28 | Token estimate: ~380 -->

**Last Updated:** 2026-09-30
**System:** Next.js 16 (Node 20) + Python 3 hybrid
**Deployment:** Docker multi-stage (Railway)

## System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser / Client                        │
├─────────────────────────────────────────────────────────────────┤
│  React 19 + App Router                                          │
│  ├─ app/page.tsx (entry)                                        │
│  ├─ components/BookScanTool.tsx (orchestrator)                  │
│  ├─ lib/pipeline.ts (two-pass render + deskew)                  │
│  └─ lib/fullfixPipeline.ts (chunked upload orchestration)       │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP FormData
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│              Next.js API Routes (Node.js Process)               │
├─────────────────────────────────────────────────────────────────┤
│  POST /api/fullfix, /api/clean, /api/straighten                 │
│  ├─ Job creation (create form → jobId)                          │
│  ├─ Chunk handling (accumulate file to disk)                    │
│  ├─ Subprocess spawn (spawn Python script)                      │
│  ├─ Progress poll (read progress.json)                          │
│  ├─ Download (serve output.pdf)                                 │
│  └─ Cleanup (delete temp dir after 10min)                       │
└────────────────────────────┬────────────────────────────────────┘
                             │ spawn('python', [script, ...args])
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│              Python Subprocess Pool                              │
├─────────────────────────────────────────────────────────────────┤
│  • fullfix_pdf.py → straighten + clean + dewarp (combined)      │
│  • clean_pdf.py   → clean only (background/bleed-through)       │
│  • straighten_pdf.py → skew detection + rotation                │
│                                                                  │
│  Dependencies:                                                  │
│  ├─ pymupdf (page rendering at N DPI)                           │
│  ├─ opencv-python (image processing)                            │
│  ├─ numpy (matrix ops)                                          │
│  ├─ scipy (polynomial fitting)                                  │
│  └─ scripts/scanner/* (v2 pipeline: detect→rectify→dewarp)     │
└────────────────────────────┬────────────────────────────────────┘
                             │ progress.json, output.pdf
                             ↓
                        /tmp/straight-up-*
```

## Data Flow: PDF Upload → Processing → Download

### Full Fix Pipeline (3-Part Upload)

```
1. Create Job
   POST /api/fullfix?action=create
   → jobId assigned, temp dir created
   → progress.json initialized to "preparing"

2. Chunk Uploads (400 MB chunks)
   FOR each chunk:
     POST /api/fullfix
     FormData: {action: 'chunk', jobId, chunk: Blob}
     → appended to input.pdf

3. Start Processing
   POST /api/fullfix?action=start
   → spawns Python subprocess with args:
     python fullfix_pdf.py \
       {tempDir}/input.pdf \
       {tempDir}/output.pdf \
       {tempDir}/progress.json \
       {bookName} {straighten} {clean} {dewarp} {v2} {skipClean}

4. Poll Progress
   GET /api/fullfix?id={jobId}
   ← JSON: {phase, current, total}
   → repeat every 400ms until phase='done'

5. Download Result
   GET /api/fullfix/download?id={jobId}&name={safeName}
   ← Blob: output.pdf
   → cleaned up after 10min
```

## Processing Modes

### Mode 1: Merge-Only (Client)
```
SlotData[] → renderPageFast(~1000px) → SKIP detection →
assemblePdf(unchanged) → single PDF
```

### Mode 2: Fix Pipeline (Client + OpenCV.js)
```
PDF file → renderPageFast (detect) →
  IF angle ≥ 0.2° THEN renderPage(200 DPI) + straightenPage()
  ELSE keep untouched →
assemblePdf() → output
```

### Mode 3: Full Fix Pipeline (Server)
```
PDF upload → spawn fullfix_pdf.py with flags →
  FOR each page:
    - render at RENDER_DPI (200)
    - [if straighten] detect_skew_from_text() + rotate
    - [if dewarp] polynomial line dewarping (scanner v2)
    - [if clean] adaptive thresholding + morphology
    - write page to batch PDF
  → merge batches incrementally
  → download output.pdf
```

## Service Boundaries

| Boundary | Client | Server | Details |
|----------|--------|--------|---------|
| **Job Creation** | ✗ | ✓ | Node.js creates jobId + temp dir |
| **File Upload** | ✓ | ✓ | Browser: FormData chunks; Node: stream to disk |
| **Detection** | ✓ (OpenCV.js) | ✓ (cv2) | Client: fast; Server: optional v2 pipeline |
| **Rendering** | ✓ (pdfjs) | ✓ (pymupdf) | Client: fast 1000px; Server: 200 DPI |
| **Straightening** | ✓ (deskew.js) | ✓ (cv2/text) | Client: similarity xform; Server: rotation/v2 |
| **Dewarping** | ✗ | ✓ | Server only (scanner/dewarp.py) |
| **Cleaning** | ✗ | ✓ | Server only (cv2 morphology) |
| **Output** | ✓ (pdf-lib) | ✓ (pymupdf) | Client: reassemble; Server: batched merge |

## Deployment Architecture

**Docker Multi-Stage Build:**
1. `deps` → npm install
2. `builder` → npm postinstall + npm run build
3. `runner` → Node 20 slim + Python 3 + pip install

**Environment:**
- `NODE_ENV=production`
- `NEXT_TELEMETRY_DISABLED=1`
- `PORT=3000` (Railway default)

**File Copy at Runtime:**
- `.next/standalone/` (Node app)
- `.next/static/` (Next.js assets)
- `public/` (static files, pdfjs worker)
- `scripts/` (Python scripts)

## Related Codemaps
- [Backend Routes & Job Management](backend.md)
- [Frontend Components & Pipelines](frontend.md)
- [Data Types & Schemas](data.md)
- [Dependencies & Libraries](dependencies.md)
