# Data Types & Schemas

<!-- Generated: 2026-09-30 | Files scanned: 28 | Token estimate: ~280 -->

**Last Updated:** 2026-09-30
**Primary Location:** `lib/types.ts`, API route handlers, Python scripts
**Format:** TypeScript interfaces + JSON schemas

## Core Type Definitions

### SlotData — User Upload Container

**Location:** `lib/types.ts:1–8`

```typescript
interface SlotData {
  id: string;                    // UUID
  number: number;                // 1-indexed slot position
  file: File | null;             // PDF file or null
  pageCount: number | null;      // Pages in file, or null if not validated
  error: string | null;          // Validation error message
  isValidating: boolean;         // Actively checking page count
}
```

**Lifecycle:**
```
Initial: {id: uuid, number: 1, file: null, pageCount: null, error: null, isValidating: false}
  ↓ (drop file)
Validating: {file: File, isValidating: true}
  ↓ (read PDF page count)
Loaded: {file: File, pageCount: 25, error: null, isValidating: false}
  ↓ (invalid PDF)
Error: {file: null, error: "Invalid PDF", isValidating: false}
```

### AppStatus — High-Level Processing State

**Location:** `lib/types.ts:10–16`

```typescript
type AppStatus =
  | 'idle'        // Waiting for user input
  | 'preparing'   // Reading files, validating
  | 'processing'  // Rendering or server-side work
  | 'done'        // Completed successfully
  | 'cancelled'   // User cancelled operation
  | 'error'       // Fatal error occurred
```

### Progress Tracking

**Location:** `lib/types.ts:18–30`

```typescript
interface Progress {
  current: number;   // Pages processed so far
  total: number;     // Total pages
}

type PipelinePhase =
  | 'preparing'      // Initializing, validating, creating job
  | 'detecting'      // Fast render + angle detection
  | 'straightening'  // Full-res render + rotation
  | 'cleaning'       // Background removal (server-side)
  | 'dewarping'      // Line dewarping (server-side)
  | 'fixing'         // Server v2 pipeline
  | 'merging'        // PDF assembly
  | 'saving'         // Final write

interface PipelineProgress {
  phase: PipelinePhase;
  current: number;      // Pages done
  total: number;        // Total pages
}
```

### OutputPage — Assembled Page Metadata

**Location:** `lib/types.ts:25–36`

```typescript
interface OutputPage {
  sourceSlotId: string;           // Which slot this came from
  sourcePageIndex: number;        // 1-indexed page in source PDF
  originalSizePoints: {
    width: number;   // Points (1/72 inch)
    height: number;
  };
  detectedAngle: number;          // Degrees (positive = CCW)
  appliedAngle: number;           // Degrees actually applied
  untouched: boolean;             // true = no straightening
  method: 'text' | 'edge' | 'none';  // Detection method used
  confidence: number;             // 0.0–1.0 score
  thumbnailUrl: string | null;    // data: URL if available
  jpegBytes: Uint8Array | null;   // Encoded JPEG data
}
```

### PageAngleInfo — Detection Results Per Page

**Location:** `lib/pipeline.ts:8–15`

```typescript
interface PageAngleInfo {
  slotNumber: number;             // Source slot 1-indexed
  pageIndex: number;              // Page number 1-indexed
  angle: number;                  // Detected angle in degrees
  method: 'text' | 'edge' | 'none';  // How detected
  confidence: number;             // Detection confidence 0–1
  straightened: boolean;          // Was it straightened?
}
```

### PipelineResult — Final Output

**Location:** `lib/pipeline.ts:17–22`

```typescript
interface PipelineResult {
  blob: Blob;                     // PDF bytes
  filename: string;               // Safe filename (e.g., "my-book.pdf")
  totalPages: number;             // Page count
  angles: PageAngleInfo[];        // Per-page metadata
}
```

## Job Metadata (Backend)

### Job Structure — API Routes

**Location:** `app/api/fullfix/route.ts:14–27`, `app/api/clean/route.ts:14–17`

```typescript
// fullfix/route.ts
interface JobMetadata {
  bookName: string;               // Output PDF title
  straighten: string;             // '1' or '0'
  clean: string;                  // '1' or '0'
  dewarp: string;                 // '1' or '0'
  v2: string;                     // '1' or '0' (scanner v2 pipeline)
  skipClean: string;              // Comma-separated page numbers to skip clean
}

interface Job {
  tempDir: string;                // /tmp/straight-up-fullfix-{uuid}
  process: ChildProcess | null;   // null if not started
  metadata?: JobMetadata;         // Only in fullfix route
}
```

## Progress JSON Schema

**File:** `{tempDir}/progress.json`
**Written by:** Python script
**Read by:** Node.js API route → returned to browser

### Initial (before processing)
```json
{
  "phase": "preparing",
  "current": 0,
  "total": 0
}
```

### During processing
```json
{
  "phase": "fixing",
  "current": 15,
  "total": 100
}
```

### On completion
```json
{
  "phase": "done",
  "current": 100,
  "total": 100
}
```

### On error
```json
{
  "phase": "error",
  "error": "Process exited with code 1",
  "current": 0,
  "total": 0
}
```

## Detection Results Structure

### DeskewClient Output (OpenCV.js)

**Location:** `lib/deskew/client.ts`

```typescript
interface DetectionResult {
  angle: number;                  // Degrees, positive = CCW rotation needed
  method: 'text' | 'edge' | 'none';  // Method used for detection
  confidence: number;             // 0.0–1.0 score
}
```

**Methods:**
- `text` → Horizontal line detection via text baselines
- `edge` → Edge-based skew detection (contours)
- `none` → No detection (failed or skipped)

### StraightenResult (Output from straightenPage)

**Location:** `lib/deskew/client.ts`

```typescript
interface StraightenResult {
  jpeg: Uint8Array;               // JPEG-encoded image
  croppedWidth: number;           // After auto-crop
  croppedHeight: number;
}
```

## Constants & Thresholds

**Location:** `lib/constants.ts`

```typescript
// UI
export const SLOTS_DEFAULT = 5;
export const SLOTS_ADD_STEP = 5;
export const MAX_FILENAME_LENGTH = 150;
export const FALLBACK_FILENAME = 'merged-book';

// Detection / Straightening
export const SKIP_THRESHOLD = 0.2;          // Degrees (skip if |angle| < 0.2)
export const MIN_CONFIDENCE = 1.5;          // (unused in v1)
export const MAX_ANGLE = 10;
export const DETECT_WIDTH = 1000;           // Fast render width

// Rendering
export const RENDER_DPI = 200;
export const CLEAN_RENDER_DPI = 150;
export const MAX_RENDER_DIMENSION = 3500;
export const JPEG_QUALITY = 0.85;

// Cleaning
export const CLEAN_BLUR_SIZE = 3;
export const CLEAN_BG_KERNEL_SIZE = 51;
export const CLEAN_OPEN_KERNEL_SIZE = 3;
export const CLEAN_ADAPTIVE_BLOCK = 31;
export const CLEAN_ADAPTIVE_C = 10;

// Dewarping
export const DEWARP_DETECT_WIDTH = 1000;
export const DEWARP_MIN_LINE_WIDTH_RATIO = 0.12;
export const DEWARP_MIN_LINES = 4;
export const DEWARP_DILATION_H = 50;
export const DEWARP_DILATION_V = 3;
export const DEWARP_POLY_DEGREE = 2;
export const DEWARP_MIN_CURVATURE = 1.5;
export const DEWARP_MAX_FIT_RESIDUAL = 5.0;
export const DEWARP_MARGIN_FRACTION = 0.03;
export const DEWARP_FIELD_SIGMA_X = 30;
export const DEWARP_FIELD_SIGMA_Y = 15;
```

## FormData Structures

### /api/fullfix — Chunked Upload

**Create (action='create'):**
```
FormData {
  action: 'create'
  bookName: string
  straighten: '0' | '1'
  clean: '0' | '1'
  dewarp: '0' | '1'
  v2: '0' | '1'
  skipClean: string (comma-sep page numbers, optional)
}
```

**Chunk (action='chunk'):**
```
FormData {
  action: 'chunk'
  jobId: string
  chunkIndex: number
  chunk: File (Blob slice)
}
```

**Start (action='start'):**
```
FormData {
  action: 'start'
  jobId: string
}
```

### /api/clean, /api/straighten — Single File

```
FormData {
  file: File
  bookName: string
}
```

## Related Codemaps
- [Backend Routes & Job Management](backend.md)
- [Frontend Pipelines](frontend.md)
- [System Architecture](architecture.md)
