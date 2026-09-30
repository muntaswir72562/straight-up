# Dependencies & External Libraries

<!-- Generated: 2026-09-30 | Files scanned: 28 | Token estimate: ~250 -->

**Last Updated:** 2026-09-30
**Client:** npm + pnpm
**Server:** pip (Python 3)

## Client Dependencies (Node.js)

**Location:** `package.json`

### Production

| Package | Version | Purpose | Location |
|---------|---------|---------|----------|
| `next` | 16.3.6 | React framework, App Router, API routes | `app/`, `.next/` |
| `react` | 19.2.8 | UI library | `components/` |
| `react-dom` | 19.2.8 | DOM rendering | `components/` |
| `pdfjs-dist` | 4.10.38 | PDF parsing + rendering (client-side) | `lib/pdf/render.ts` |
| `pdf-lib` | 1.17.1 | PDF assembly + metadata | `lib/pdf/assemble.ts` |

**Total:** 5 production dependencies

### Development

| Package | Version | Purpose |
|---------|---------|---------|
| `tailwindcss` | 4 (with @tailwindcss/postcss) | CSS framework |
| `typescript` | 5 | Type checking |
| `eslint` | 9 + eslint-config-next | Linting |
| `@types/node` | 20 | Node.js types |
| `@types/react` | 19 | React types |
| `@types/react-dom` | 19 | React-DOM types |

### Postinstall Scripts

**Location:** `package.json:10` + `scripts/`

```json
"postinstall": "node scripts/copy-pdfjs-worker.js && node scripts/download-opencv.js"
```

**What it does:**
1. **copy-pdfjs-worker.js** → copies `node_modules/pdfjs-dist/build/pdf.worker.js` to `public/`
   - PDF.js worker thread needs separate file
2. **download-opencv.js** → downloads `opencv.js` (WebAssembly) to `public/`
   - ~7 MB WebAssembly binary
   - Used by DeskewClient for angle detection

### Client-Side Libraries (Not npm)

| Library | Type | Source | Purpose | Size |
|---------|------|--------|---------|------|
| **OpenCV.js** | WebAssembly | `public/opencv.js` (downloaded at postinstall) | Image processing (angle detection, straightening) | ~7 MB |

## Server Dependencies (Python 3)

**Location:** `scripts/requirements.txt`

```txt
opencv-python>=4.8        # Image processing (morphology, contours, etc.)
pymupdf>=1.23             # PDF rendering at arbitrary DPI
numpy>=1.24               # Numerical arrays
scipy>=1.11               # Polynomial fitting, advanced image ops
```

### Purpose Breakdown

| Package | Used For |
|---------|----------|
| **opencv-python (cv2)** | Contour detection, line detection, morphological operations (clean), dewarping |
| **pymupdf (fitz)** | Render PDF pages as raster images at specified DPI |
| **numpy** | Image data as arrays, matrix operations for transforms |
| **scipy** | Polynomial fitting for text-line dewarping, interpolation |

### Python Script Imports

**fullfix_pdf.py:**
```python
import fitz  # pymupdf
import cv2   # opencv-python
import numpy as np
from straighten_pdf import detect_skew_from_text, straighten_page
from clean_pdf import dewarp_page, clean_page
```

**clean_pdf.py:**
```python
import fitz
import cv2
import numpy as np
```

**straighten_pdf.py:**
```python
import fitz
import cv2
import numpy as np
```

**scanner/scan_page.py:**
```python
from .detect import detect_document
from .rectify import rectify
from .dewarp import dewarp
from .layout import align_columns
```

## Docker Build & Deployment

**Location:** `Dockerfile`

### Stage 1: Dependencies
```dockerfile
FROM node:20-slim AS deps
COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts
```
- Installs npm packages without postinstall scripts

### Stage 2: Builder
```dockerfile
FROM node:20-slim AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run postinstall    # Now run postinstall: copy pdfjs worker, download opencv.js
RUN npm run build          # Next.js build → .next/
```
- Creates standalone output in `.next/standalone/`
- Copies static assets and Python scripts

### Stage 3: Runtime
```dockerfile
FROM node:20-slim AS runner
WORKDIR /app

# Install Python + system dependencies
RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv \
    libgl1 libglib2.0-0  # OpenCV dependencies
RUN ln -sf /usr/bin/python3 /usr/bin/python

# Install Python packages
COPY scripts/requirements.txt /tmp/
RUN pip3 install --no-cache-dir --break-system-packages -r /tmp/requirements.txt

# Copy built app
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/scripts ./scripts

EXPOSE 3000
CMD ["node", "server.js"]
```

**Final Image Size:** ~1.2–1.5 GB (Node + Python + cv2 wheels)

### System Packages

| Package | Version | Why |
|---------|---------|-----|
| `libgl1` | from libc6 | OpenCV (cv2) depends on OpenGL libs |
| `libglib2.0-0` | from glib2.0 | OpenCV dependency |

## Build Size & Optimization

### Node Modules (~400 MB pre-install)
- `next` + deps: ~200 MB
- `pdfjs-dist`: ~10 MB
- `pdf-lib`: ~2 MB
- `react`, `react-dom`: ~50 MB combined
- dev dependencies: ~140 MB (unused in production)

### Production Output (.next/standalone)
- JavaScript bundles: ~600 KB–1 MB
- Static assets: pdfjs worker (~5 MB), opencv.js (~7 MB)

### Python Wheels
- `opencv-python`: ~80–100 MB
- `pymupdf`: ~30–40 MB
- `numpy`: ~50 MB
- `scipy`: ~80–100 MB
- Total: ~240–300 MB

## Network & Download Behavior

### Client-Side Download (Browser)

1. **Pdfjs-dist** — loaded dynamically from `node_modules` (bundled in Next.js)
2. **OpenCV.js** — loaded on demand when DeskewClient.init() called
   - Triggered when merge/fix pipelines start
   - 7 MB one-time download
   - Cached by browser for future use

### Server-Side Dependencies

- Python packages installed at Docker build time
- All in Docker image, no runtime downloads

## Environment Variables

**Not explicitly used in this codebase**, but available in Railway:

```bash
NODE_ENV=production
NEXT_TELEMETRY_DISABLED=1
PORT=3000
HOSTNAME=0.0.0.0
```

## Performance Characteristics

### Client Memory
- **PDF parsing:** Streamed by pdfjs (no full buffer)
- **Image rendering:** Canvas ImageData (~width × height × 4 bytes)
  - 1000px wide page: ~4 MB
  - 2000px wide page: ~16 MB
- **Upload:** File.slice() = zero copy (zero memory overhead)

### Server Memory
- **Python subprocess:** One process per job
- **PDF rendering:** Raster at target DPI
  - 200 DPI A4 ≈ 1650×2340 px ≈ 15 MB per page (RGBA)
  - Batch processing: 20 pages = 300 MB (GC between batches)
- **Batching:** Merge batches incrementally to cap memory

### Network
- **Upload:** Chunked (400 MB per chunk), streaming
- **Download:** Native browser download (streaming)
- **Polling:** 400 ms interval (negligible)

## Licenses

| Package | License | Notes |
|---------|---------|-------|
| `next` | MIT | Vercel |
| `react` | MIT | Meta |
| `pdfjs-dist` | Apache 2.0 | Mozilla |
| `pdf-lib` | MIT | |
| `opencv-python` | Apache 2.0 | OpenCV Foundation |
| `pymupdf` | AGPL 3.0 | Artifex Software (check usage!) |
| `numpy` | BSD | NumPy developers |
| `scipy` | BSD | SciPy developers |

**Note:** PyMuPDF uses AGPL 3.0. Deployment should comply with license terms.

## Related Codemaps
- [System Architecture](architecture.md)
- [Backend Routes & Deployment](backend.md)
- [Frontend Components](frontend.md)
