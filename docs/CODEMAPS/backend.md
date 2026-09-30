# Backend: API Routes & Python Scripts

<!-- Generated: 2026-09-30 | Files scanned: 28 | Token estimate: ~420 -->

**Last Updated:** 2026-09-30
**Entry Points:** `/api/fullfix`, `/api/clean`, `/api/straighten`
**Language:** TypeScript (Node.js), Python 3

## API Routes Architecture

### `/api/fullfix/route.ts` — Full PDF Fix with Chunked Upload

**File:** `app/api/fullfix/route.ts` (256 lines)

```
POST /api/fullfix
├─ action='create' → handleCreate()
│  ├─ Extract: bookName, straighten, clean, dewarp, v2, skipClean
│  ├─ Validate: at least one operation selected
│  ├─ Create: tempDir in /tmp/straight-up-fullfix-{uuid}
│  ├─ Write: progress.json → {phase: 'preparing', current: 0, total: 0}
│  └─ Return: {jobId}
│
├─ action='chunk' → handleChunk()
│  ├─ Extract: jobId, chunk (File)
│  ├─ Validate: job exists
│  ├─ Append: chunk to input.pdf (streaming, no buffer)
│  └─ Return: {ok: true}
│
└─ action='start' → handleStart()
   ├─ Validate: job exists, not already started
   ├─ Spawn: python fullfix_pdf.py {args}
   ├─ Attach: stderr → process.stderr
   ├─ On close: write error phase if code !== 0
   ├─ Schedule: cleanup after 10min
   └─ Return: {started: true}

GET /api/fullfix?id={jobId}
├─ Lookup: job from Map
├─ Read: progress.json
└─ Return: {phase, current, total}

DELETE /api/fullfix?id={jobId}
├─ Kill: job.process
├─ Remove: job from Map
├─ Clean: tempDir recursively
└─ Return: {cancelled: true}

Legacy POST (no action)
└─ handleLegacyUpload() → single-file upload (backward compat)
```

**Key Data Structure:**
```typescript
interface Job {
  tempDir: string;          // /tmp/straight-up-fullfix-{uuid}
  process: ChildProcess | null;
  metadata?: JobMetadata;   // bookName, straighten, clean, dewarp, v2, skipClean
}
```

**Temp Directory Layout:**
```
/tmp/straight-up-fullfix-{jobId}/
├─ input.pdf         (user-uploaded file, streamed to disk)
├─ output.pdf        (Python writes this)
└─ progress.json     (Python updates after each page)
```

### `/api/clean/route.ts` — Single-File Cleaning

**File:** `app/api/clean/route.ts` (127 lines)

```
POST /api/clean
├─ Extract: file (File), bookName
├─ Validate: file provided
├─ Create: tempDir in /tmp/straight-up-clean-{uuid}
├─ Stream: file to input.pdf
├─ Spawn: python clean_pdf.py {inputPath} {outputPath} {progressPath} {bookName}
├─ Attach: job to Map
├─ On close: write error phase if code !== 0
├─ Schedule: cleanup after 10min
└─ Return: {jobId}

GET /api/clean?id={jobId}
└─ Read and return: progress.json

DELETE /api/clean?id={jobId}
├─ Kill process, remove job, clean tempDir
└─ Return: {cancelled: true}
```

### `/api/straighten/route.ts` — Single-File Straightening

**File:** `app/api/straighten/route.ts` (126 lines)

Identical structure to `/api/clean`:
```
POST /api/straighten → spawn straighten_pdf.py
GET /api/straighten?id={jobId} → poll progress
DELETE /api/straighten?id={jobId} → cancel job
```

## Python Scripts

### `scripts/fullfix_pdf.py` — Full Processing Pipeline

**Signature:**
```python
python fullfix_pdf.py <input> <output> <progress_file> <book_name> \
  <straighten:0|1> <clean:0|1> <dewarp:0|1> <v2:0|1> <skipClean>
```

**Main Flow:**
```python
def process_page(doc, idx, do_straighten, do_clean, do_dewarp, do_v2, total):
  1. render page at RENDER_DPI (200)
  2. IF do_straighten: detect_skew_from_text() → rotate page
  3. IF do_v2: process_page_v2() → detect→rectify→dewarp→align
  4. IF do_clean: clean_page() → adaptive thresholding + morphology
  5. JPEG encode at quality 92
  6. write_progress(path, 'fixing', current, total)
  return page for batch accumulation

Main:
  1. Open input PDF
  2. FOR each page: process_page() → batch PDF
  3. Merge batches incrementally (cap memory at BATCH_SIZE=20)
  4. Set metadata (title) on final output
  5. Save with deflate compression
```

**Dependencies:** pymupdf, cv2, numpy, scipy, scripts/scanner/*

### `scripts/clean_pdf.py` — Cleaning Only

**Simplified flow:**
```python
FOR each page:
  1. render at RENDER_DPI
  2. clean_page(img) → adaptive threshold + morphology
  3. write progress
  JPEG encode → batch accumulate
```

### `scripts/straighten_pdf.py` — Straightening Only

**Simplified flow:**
```python
FOR each page:
  1. render at RENDER_DPI
  2. detect_skew_from_text(img) → angle, confidence, method
  3. IF |angle| > MIN_SKEW_ANGLE: rotate via affine transform
  4. write progress
  JPEG encode → batch accumulate
```

## Job Lifecycle Diagram

```
[Browser]
    │
    ├─→ POST create
    │   └─→ Node: tempDir created, progress.json initialized
    │
    ├─→ POST chunk (×N)
    │   └─→ Node: append to input.pdf
    │
    ├─→ POST start
    │   └─→ Node: spawn Python subprocess
    │       └─→ Python: read input.pdf, process page-by-page
    │           ├─ Render at DPI
    │           ├─ Apply operations (straighten, clean, dewarp)
    │           ├─ Write progress.json: {phase: 'fixing', current: N, total: T}
    │           └─ Write batch PDFs, then merge
    │
    ├─→ GET poll (every 400ms)
    │   ├─→ Node: read progress.json
    │   └─→ Return: {phase, current, total}
    │
    ├─→ (when phase='done')
    │   └─→ GET download
    │       └─→ Node: stream output.pdf
    │
    └─→ (10min after completion)
        └─→ Node: cleanup job from Map, rm tempDir
```

## Progress JSON Schema

**Written by Python, read by Node:**
```json
{
  "phase": "fixing|error|done",
  "current": 5,
  "total": 100,
  "error": "optional error message"
}
```

**Phases in fullfix_pdf.py:**
- `preparing` → initial state
- `fixing` → processing pages
- `error` → Python exited with non-zero code
- `done` → all pages processed, batches merged

## Memory Management

**Chunked Upload:**
- 400 MB chunks (client: `file.slice()` = zero buffering)
- Node: stream to disk via `pipeline(readable, writeStream)`
- No full PDF buffered in Node memory

**Batch Processing (Python):**
- BATCH_SIZE = 20 pages per batch file
- Batches merged incrementally (one at a time to disk)
- `gc.collect()` after each batch to free memory

**Cleanup:**
- CLEANUP_DELAY = 10 minutes (allows time for user download)
- After delay: delete tempDir, remove job from Map

## Related Codemaps
- [System Architecture](architecture.md)
- [Frontend Pipelines](frontend.md)
- [Data Types & Schemas](data.md)
