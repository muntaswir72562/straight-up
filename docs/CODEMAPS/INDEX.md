# Architecture Codemaps — Straight Up

<!-- Generated: 2026-09-30 | Total files scanned: 28 | Total tokens: ~1,700 -->

Welcome to the Straight Up architecture documentation. These codemaps provide a comprehensive reference for understanding the codebase structure, data flow, and deployment.

## Quick Navigation

### For Developers New to the Codebase
1. Start with **[System Architecture](architecture.md)** — understand the three main services (Frontend, API Routes, Python)
2. Read **[Frontend Components](frontend.md)** — learn the component tree and three pipeline functions
3. Review **[Backend Routes](backend.md)** — understand API job lifecycle and subprocess management
4. Reference **[Data Types](data.md)** — know the type definitions and schemas

### For Operations / DevOps
1. **[System Architecture](architecture.md)** — service boundaries and data flow
2. **[Dependencies & Deployment](dependencies.md)** — Docker, Python packages, build process

### For API Integration / Frontend Work
1. **[Backend Routes](backend.md)** — API endpoints and job management
2. **[Data Types](data.md)** — request/response schemas and progress tracking

### For Python / Image Processing Work
1. **[Backend Routes](backend.md)** — Python script entry points and arguments
2. **[Data Types](data.md)** — progress.json schema, detection results
3. **[Dependencies](dependencies.md)** — cv2, pymupdf, scipy usage

---

## Codemaps at a Glance

| Document | Purpose | Key Content | Audience |
|----------|---------|-------------|----------|
| **[architecture.md](architecture.md)** | High-level system design | System diagram, service boundaries, three processing modes | Everyone |
| **[frontend.md](frontend.md)** | UI components & client pipelines | Component tree, three pipeline functions (merge, fix, fullfix) | Frontend engineers |
| **[backend.md](backend.md)** | API routes & Python integration | Job lifecycle, temp file management, subprocess spawning | Backend engineers, DevOps |
| **[data.md](data.md)** | Type definitions & schemas | TypeScript interfaces, JSON schemas, constants, FormData structures | Full-stack engineers |
| **[dependencies.md](dependencies.md)** | External libraries & Docker | npm packages, Python packages, multi-stage build, Docker layers | DevOps, infrastructure |

---

## System Overview

**Straight Up** is a hybrid Next.js 16 + Python 3 application for document scanning:

- **Purpose:** Straighten skewed PDF pages, dewarp curved text, clean backgrounds
- **Stack:** React 19, TypeScript, Tailwind CSS (frontend) + Node.js API routes + Python 3 (backend)
- **Deployment:** Docker multi-stage build → Railway

### Three Processing Modes

1. **Merge Mode** — Combine multiple PDFs with optional angle detection (client-side)
2. **Fix Mode** — Straighten a single PDF (client-side with OpenCV.js)
3. **Full Fix Mode** — Multi-operation pipeline (server-side: straighten + clean + dewarp + v2 scanner)

### Key Architecture Features

- **Two-Pass Rendering** — Fast detection at 1000px, then full-res (200 DPI) only for pages needing work
- **Chunked Upload** — 400 MB chunks, zero client-side buffering
- **Job Management** — Module-level Map, temp files auto-cleanup after 10 min
- **Progress Tracking** — Python writes progress.json per-page, browser polls every 400 ms
- **Batched PDF Processing** — 20 pages per batch, incremental merge to cap memory

---

## File Structure (28 Core Files Analyzed)

```
docs/CODEMAPS/
├─ INDEX.md (this file)
├─ architecture.md
├─ frontend.md
├─ backend.md
├─ data.md
└─ dependencies.md

app/
├─ page.tsx (Next.js entry)
└─ api/
   ├─ fullfix/route.ts (chunked upload + full pipeline)
   ├─ clean/route.ts (cleaning only)
   └─ straighten/route.ts (straightening only)

components/
├─ BookScanTool.tsx (main orchestrator)
├─ BookNameInput.tsx
├─ FixDropZone.tsx
├─ SlotGrid.tsx, Slot.tsx
├─ PageGrid.tsx, PageThumbnail.tsx
├─ ProgressPanel.tsx
├─ ResultPanel.tsx
└─ ClientApp.tsx

lib/
├─ pipeline.ts (runPipeline, runFixPipeline)
├─ fullfixPipeline.ts (runFullfixPipeline)
├─ types.ts (SlotData, PipelineProgress, etc.)
├─ constants.ts (SKIP_THRESHOLD, RENDER_DPI, etc.)
├─ deskew/client.ts (OpenCV.js wrapper)
└─ pdf/
   ├─ render.ts (loadPdfDocument, renderPage, renderPageFast)
   └─ assemble.ts (assemblePdf)

scripts/
├─ fullfix_pdf.py (main server pipeline)
├─ clean_pdf.py (cleaning only)
├─ straighten_pdf.py (straightening only)
├─ requirements.txt
└─ scanner/
   ├─ scan_page.py (v2 pipeline wrapper)
   ├─ detect.py (document boundary detection)
   ├─ rectify.py (perspective correction)
   ├─ dewarp.py (text-line dewarping)
   └─ layout.py (column alignment)

Docker
├─ Dockerfile (multi-stage: deps, builder, runner)
└─ package.json (npm scripts, dependencies)
```

---

## Data Flow Summary

### Upload → Processing → Download

```
1. Browser: Choose files or drop PDF
2. Frontend: Validate PDF (page count)
3. Frontend: Choose processing mode + options
4. Upload:
   - Merge/Fix: Load PDF in browser
   - FullFix: Upload in 400 MB chunks to server
5. Processing:
   - Merge/Fix: Render pages, detect angles, straighten (client-side)
   - FullFix: Python subprocess handles all
6. Output: PDF reassembled with modifications
7. Download: Browser downloads result
```

### Key Interfaces

```typescript
SlotData { id, number, file, pageCount, error, isValidating }
PipelineProgress { phase, current, total }
PageAngleInfo { slotNumber, pageIndex, angle, method, confidence, straightened }
PipelineResult { blob, filename, totalPages, angles[] }
```

---

## Performance Highlights

- **Client Upload:** File.slice() = zero buffering
- **Detection:** ~1000px render (~4 MB per page)
- **Straightening:** Full-res only when needed (200 DPI)
- **Python:** Batch processing (20 pages), incremental merge
- **Docker:** ~1.2–1.5 GB final image (Node + Python + CV)

---

## Common Tasks

### To Add a New Pipeline Mode
1. Read [frontend.md](frontend.md) — understand runPipeline structure
2. Duplicate runPipeline or runFullfixPipeline
3. Add phase constants to [data.md](data.md)
4. Update BookScanTool.tsx with new mode

### To Modify Image Processing
1. Update Python script in `scripts/`
2. Update progress.json phases in [backend.md](backend.md)
3. Test locally: `python fullfix_pdf.py ...`
4. Update Docker requirements.txt if adding packages

### To Change Upload Behavior
1. Read [backend.md](backend.md) — API route structure
2. Modify handleChunk or handleStart in route.ts
3. Update client in [frontend.md](frontend.md) — fullfixPipeline.ts

### To Deploy
1. Review [dependencies.md](dependencies.md) — Docker build process
2. Ensure `scripts/requirements.txt` is up to date
3. Build: `docker build -t straight-up .`
4. Run: `docker run -p 3000:3000 straight-up`

---

## References

- **Next.js 16 Documentation:** https://nextjs.org/docs
- **React 19 Docs:** https://react.dev
- **PDF.js:** https://mozilla.github.io/pdf.js/
- **OpenCV.js:** https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html
- **PyMuPDF (fitz):** https://pymupdf.readthedocs.io/
- **OpenCV (cv2):** https://docs.opencv.org/4.x/
- **NumPy:** https://numpy.org/doc/stable/
- **SciPy:** https://scipy.readthedocs.io/

---

## Maintenance

**Last Updated:** 2026-09-30
**Files Scanned:** 28 core project files
**Token Estimate:** ~1,700 (all codemaps combined)

These codemaps are generated from the actual codebase using automated analysis. To keep them fresh:
1. Re-run codemap generation after major architectural changes
2. Update timestamps when modifying API signatures
3. Keep file path references verified (checked against actual repo)

---

## Quick Links

- **Source Code:** C:\Users\MuntaswirW\straight-up
- **Architecture Entry Point:** app/page.tsx → components/BookScanTool.tsx
- **API Routes:** app/api/{fullfix,clean,straighten}/route.ts
- **Python Backend:** scripts/{fullfix_pdf,clean_pdf,straighten_pdf}.py
- **Config:** Dockerfile, package.json, scripts/requirements.txt
