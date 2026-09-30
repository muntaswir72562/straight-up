# Frontend: Components & Client Pipelines

<!-- Generated: 2026-09-30 | Files scanned: 28 | Token estimate: ~380 -->

**Last Updated:** 2026-09-30
**Framework:** Next.js 16 (App Router) + React 19 + Tailwind CSS
**Entry Point:** `app/page.tsx`

## Component Tree

```
app/page.tsx (root page)
│
└─ components/ClientApp.tsx (client boundary marker)
   │
   ├─ components/BookScanTool.tsx (main orchestrator)
   │  ├─ State: slots[], appStatus, progress, results, bookName, mode
   │  │
   │  ├─ components/BookNameInput.tsx
   │  │  └─ <input> → setBookName()
   │  │
   │  ├─ components/FixDropZone.tsx
   │  │  ├─ File drop zone for single PDF
   │  │  ├─ onSuccess() → runFixPipeline() | runFullfixPipeline()
   │  │  └─ UI: file upload, operation toggles (straighten, clean, dewarp)
   │  │
   │  ├─ components/SlotGrid.tsx
   │  │  ├─ Render: [Slot, Slot, ..., AddMore button]
   │  │  └─ Slot count increases by SLOTS_ADD_STEP
   │  │
   │  ├─ components/Slot.tsx
   │  │  ├─ State: dragHover, validating
   │  │  ├─ onDrop() → setFile() + validatePdf()
   │  │  ├─ Shows: file name, page count, error or loading
   │  │  └─ allowMultiple: N/A (single file per slot)
   │  │
   │  ├─ components/PageGrid.tsx (results view)
   │  │  ├─ Maps: assembled pages from result
   │  │  └─ Renders: PageThumbnail for each page
   │  │
   │  ├─ components/PageThumbnail.tsx
   │  │  ├─ Displays: thumbnail, page number, angle info
   │  │  ├─ Shows: detection method (text/edge/none)
   │  │  └─ Shows: confidence score
   │  │
   │  ├─ components/ProgressPanel.tsx
   │  │  ├─ Props: phase, current, total, error
   │  │  ├─ Shows: progress bar, ETA, detailed phase logs
   │  │  └─ Actions: cancel button
   │  │
   │  └─ components/ResultPanel.tsx
   │     ├─ Displays: final results (download, stats)
   │     ├─ Shows: {straightened: N, untouched: M, total: T}
   │     └─ Actions: download PDF, reset for new upload
   │
   ├─ lib/deskew/client.ts (OpenCV.js wrapper)
   │  ├─ DeskewClient.init() → load OpenCV.js from public/
   │  ├─ detectAngle(imageData, w, h) → {angle, method, confidence}
   │  ├─ straightenPage(imageData, w, h, angle, autoCrop) → {jpeg, croppedW, croppedH}
   │  └─ Uses: cv.findContours(), cv.fitLine(), similarity transforms
   │
   └─ lib/pdf/ (PDF utilities)
      ├─ render.ts
      │  ├─ loadPdfDocument(file) → PDFDocumentProxy
      │  ├─ renderPageFast(pdf, pageNum) → {imageData, width, height, pageSizePoints}
      │  └─ renderPage(pdf, pageNum) → {imageData, width, height, pageSizePoints}
      │
      └─ assemble.ts
         ├─ assemblePdf(config, pages, onProgress, cancelRef) → Uint8Array
         ├─ Merges: multiple source PDFs
         ├─ Replaces: pages with JPEG (straightened)
         └─ Metadata: sets bookTitle
```

## Three Pipeline Functions

### 1. `runPipeline()` — Merge Multiple PDFs with Optional Detection

**Location:** `lib/pipeline.ts:59–229`
**Signature:**
```typescript
async function runPipeline(
  slots: SlotData[],
  bookName: string,
  onProgress: (progress: PipelineProgress) => void,
  cancelRef: { cancelled: boolean }
): Promise<PipelineResult>
```

**Flow (Two-Pass Rendering):**
```
Phase 1: Preparing
├─ Initialize OpenCV worker (DeskewClient)
└─ onProgress({phase: 'preparing', current: 0, total: totalPages})

Phase 2: Detecting (fast ~1000px render)
├─ FOR each page in each slot:
│  ├─ renderPageFast() → low-res image
│  ├─ deskew.detectAngle() → {angle, method, confidence}
│  ├─ IF |angle| >= SKIP_THRESHOLD (0.2°): mark straighten=true
│  └─ Collect angle info + page refs
└─ onProgress({phase: 'detecting', current: N, total: totalPages})

Phase 3: Straightening (full-res 200 DPI, only if needed)
├─ Filter pages where straightened=true
├─ FOR each page needing straightening:
│  ├─ renderPage() → full-res image
│  ├─ deskew.straightenPage() → JPEG bytes
│  ├─ Store in assemblePages[i]
│  └─ onProgress({phase: 'straightening', current: i+1, total: needsStraighten})
└─ Skip untouched pages (no re-render)

Phase 4: Merging (pdf-lib)
├─ Collect all PDF bytes from slots
├─ assemblePdf(pdfs, assemblePages) → merged PDF
└─ onProgress({phase: 'merging', current: N, total: totalPages})

Return: {blob, filename, totalPages, angles[]}
```

**Key Optimization:** Only render at full resolution (200 DPI) pages that need straightening. Untouched pages kept as-is from source PDFs.

### 2. `runFixPipeline()` — Straighten Single PDF (Client-Side)

**Location:** `lib/pipeline.ts:235–379`
**Signature:**
```typescript
async function runFixPipeline(
  file: File,
  bookName: string,
  onProgress: (progress: PipelineProgress) => void,
  cancelRef: { cancelled: boolean }
): Promise<PipelineResult>
```

**Flow (Identical Two-Pass as runPipeline, but single PDF):**
```
Same phases as runPipeline:
1. Preparing → OpenCV init
2. Detecting → fast-render all pages
3. Straightening → full-render only straighten=true pages
4. Merging → reassemble into output

Key difference: Single source PDF, so faster preparation phase
```

**Fallback:** If OpenCV.js fails to load, return unmodified PDF

### 3. `runFullfixPipeline()` — Full Fix via Server

**Location:** `lib/fullfixPipeline.ts:16–151`
**Signature:**
```typescript
async function runFullfixPipeline(
  file: File,
  bookName: string,
  options: { straighten, clean, dewarp, v2, skipClean? },
  onProgress: (progress: PipelineProgress) => void,
  cancelRef: { cancelled: boolean }
): Promise<PipelineResult>
```

**Flow (Chunked Upload + Server Processing):**
```
Step 1: Create Job
├─ POST /api/fullfix?action=create
├─ Send: bookName, straighten, clean, dewarp, v2, skipClean
└─ Receive: jobId

Step 2: Upload in Chunks (400 MB each)
├─ FOR i in range(totalChunks):
│  ├─ blob = file.slice(i*400MB, (i+1)*400MB)
│  ├─ POST /api/fullfix?action=chunk with blob
│  └─ onProgress({phase: 'preparing', current: i+1, total: totalChunks})
└─ Zero client-side buffering via file.slice()

Step 3: Start Processing
├─ POST /api/fullfix?action=start
└─ Server spawns: python fullfix_pdf.py {...}

Step 4: Poll for Progress
├─ GET /api/fullfix?id=jobId every 400ms
├─ Parse: {phase, current, total}
└─ onProgress() until phase='done'

Step 5: Download
├─ GET /api/fullfix/download?id=jobId&name={safeName}
├─ Native browser download (href + click)
└─ Automatic cleanup after 10min on server
```

**Supported Phases (from Python):**
- `preparing` → chunks uploading
- `fixing` → processing pages
- `error` → Python failed
- `done` → complete

**v2 Mode:** Enables scanner v2 pipeline (detect→rectify→dewarp→align) server-side

## Pipeline Mode Selection (BookScanTool)

```typescript
if (mode === 'merge') {
  // Merge multiple PDFs, optional angle detection
  await runPipeline(slots, bookName, onProgress, cancelRef);
}

if (mode === 'fix') {
  // Single PDF fix (client-side with OpenCV.js)
  await runFixPipeline(file, bookName, onProgress, cancelRef);
}

if (mode === 'fullfix') {
  // Single PDF fix (server-side with Python + full options)
  await runFullfixPipeline(file, bookName, {straighten, clean, dewarp, v2}, onProgress, cancelRef);
}
```

## State Management

**BookScanTool uses local state (React hooks):**
```typescript
const [slots, setSlots] = useState<SlotData[]>(...)
const [appStatus, setAppStatus] = useState<AppStatus>('idle')
const [progress, setProgress] = useState<PipelineProgress>(...)
const [results, setResults] = useState<PipelineResult | null>(null)
const [bookName, setBookName] = useState<string>('My Book')
const [mode, setMode] = useState<'merge' | 'fix' | 'fullfix'>('merge')
```

**No Redux/Zustand** — all state local to BookScanTool component

## Related Codemaps
- [System Architecture](architecture.md)
- [Backend Routes & Job Management](backend.md)
- [Data Types & Schemas](data.md)
- [Dependencies & Libraries](dependencies.md)
