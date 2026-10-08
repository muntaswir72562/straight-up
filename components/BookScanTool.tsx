'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { SlotData, AppStatus, Progress } from '@/lib/types';
import { SLOTS_DEFAULT, SLOTS_ADD_STEP } from '@/lib/constants';
import { naturalSortCompare } from '@/lib/naturalSort';
import { validatePdf, loadPdfDocument } from '@/lib/pdf/render';
import { runMergeOnlyPipeline, type PageAngleInfo, type PipelinePhase } from '@/lib/pipeline';
import { runReplacePipeline } from '@/lib/replacePipeline';
import { clearThumbnailCache } from '@/lib/pdf/thumbnail';
import { loadForExtraction, clearExtraction } from '@/lib/pdf/extractThumb';
import { runFullfixPipeline } from '@/lib/fullfixPipeline';

import { BookNameInput } from './BookNameInput';
import { SlotGrid } from './SlotGrid';
import { FixDropZone } from './FixDropZone';
import { PageGrid, type Insertion } from './PageGrid';
import { ProgressPanel } from './ProgressPanel';
import { ResultPanel } from './ResultPanel';
import { PageViewModal } from './PageViewModal';
import { FullscreenViewer } from './FullscreenViewer';

type ToolMode = 'merge' | 'fullfix' | 'replace';

interface FixQueueEntry {
  id: string;
  file: File;
  pageCount: number | null;
  error: string | null;
  isValidating: boolean;
  status: 'pending' | 'processing' | 'done' | 'error';
}

function createSlots(count: number, startNumber: number): SlotData[] {
  return Array.from({ length: count }, (_, i) => ({
    id: crypto.randomUUID(),
    number: startNumber + i,
    file: null,
    pageCount: null,
    error: null,
    isValidating: false,
  }));
}

export function BookScanTool() {
  // --- Mode ---
  const [mode, setMode] = useState<ToolMode>('merge');

  // --- Merge mode state ---
  const [bookName, setBookName] = useState('');
  const [slots, setSlots] = useState<SlotData[]>(() => createSlots(SLOTS_DEFAULT, 1));


  // --- Full fix mode state ---
  const [fixFile, setFixFile] = useState<File | null>(null);
  const [fixPageCount, setFixPageCount] = useState<number | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const [fixIsValidating, setFixIsValidating] = useState(false);
  const [fixFiles, setFixFiles] = useState<FixQueueEntry[]>([]);
  const [fixQueueLabel, setFixQueueLabel] = useState('');
  const [fullfixStraighten, setFullfixStraighten] = useState(false);
  const [fullfixClean, setFullfixClean] = useState(false);
  const [fullfixDewarp, setFullfixDewarp] = useState(false);
  const [fullfixV2, setFullfixV2] = useState(false);
  const [fullfixSkipClean, setFullfixSkipClean] = useState('1');
  const [fullfixSkipStraighten, setFullfixSkipStraighten] = useState('');
  const [fullfixSkipDewarp, setFullfixSkipDewarp] = useState('');
  const [fullfixOcr, setFullfixOcr] = useState(false);
  const [fullfixAudit, setFullfixAudit] = useState(true);

  // --- Replace mode state ---
  const [replaceFile, setReplaceFile] = useState<File | null>(null);
  const [replacePageCount, setReplacePageCount] = useState<number | null>(null);
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const [replaceIsValidating, setReplaceIsValidating] = useState(false);
  const [replacements, setReplacements] = useState<Map<number, File>>(new Map());
  const [deletions, setDeletions] = useState<Set<number>>(new Set());
  const [insertions, setInsertions] = useState<Insertion[]>([]);
  const [replacePdf, setReplacePdf] = useState<PDFDocumentProxy | null>(null);
  const [viewingPage, setViewingPage] = useState<number | null>(null);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [pageOrder, setPageOrder] = useState<number[]>([]);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());

  // --- Shared state ---
  const [status, setStatus] = useState<AppStatus>('idle');
  const [progress, setProgress] = useState<Progress>({ current: 0, total: 0 });
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadFilename, setDownloadFilename] = useState('');
  const [resultTotalPages, setResultTotalPages] = useState(0);
  const [resultAngles, setResultAngles] = useState<PageAngleInfo[]>([]);
  const [progressPhase, setProgressPhase] = useState<PipelinePhase>('preparing');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const cancelRef = useRef({ cancelled: false });

  const locked = status !== 'idle';

  const canStartSlots =
    bookName.trim().length > 0 &&
    slots.some((s) => s.file !== null) &&
    status === 'idle' &&
    !slots.some((s) => s.isValidating);

  const fixHasValidFiles = fixFiles.length > 0
    ? fixFiles.some((f) => !f.error && f.pageCount !== null && !f.isValidating)
    : fixFile !== null && !fixIsValidating;

  const canStartFix =
    fixHasValidFiles &&
    (fullfixStraighten || fullfixClean || fullfixDewarp || fullfixV2 || fullfixOcr) &&
    status === 'idle';

  const isDefaultOrder = pageOrder.length > 0 && pageOrder.every((pn, i) => pn === i + 1);
  const hasPageOrderChange = pageOrder.length > 0 && !isDefaultOrder;

  const canStartReplace =
    replaceFile !== null &&
    (replacements.size > 0 || deletions.size > 0 || insertions.length > 0 || hasPageOrderChange) &&
    status === 'idle';

  const canStart =
    mode === 'fullfix' ? canStartFix :
    mode === 'replace' ? canStartReplace :
    canStartSlots;

  // --- Mode switching ---
  const handleModeChange = useCallback(
    (newMode: ToolMode) => {
      if (locked || newMode === mode) return;
      setMode(newMode);
      if (newMode !== 'merge') {
        setSlots(createSlots(SLOTS_DEFAULT, 1));
      }
      if (newMode !== 'fullfix') {
        setFixFile(null);
        setFixPageCount(null);
        setFixError(null);
        setFixIsValidating(false);
        setFixFiles([]);
        setFixQueueLabel('');
      }
      if (newMode !== 'replace') {
        if (replacePdf) replacePdf.destroy();
        setReplacePdf(null);
        setReplaceFile(null);
        setReplacePageCount(null);
        setReplaceError(null);
        setReplaceIsValidating(false);
        setReplacements(new Map());
        setDeletions(new Set());
        setInsertions([]);
      }
    },
    [locked, mode, replacePdf]
  );

  // --- beforeunload warning ---
  useEffect(() => {
    if (status !== 'processing') return;

    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };

    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [status]);

  // --- Cleanup download URL on unmount or start over ---
  useEffect(() => {
    return () => {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    };
  }, [downloadUrl]);

  // --- Merge mode: Validation helper ---
  const runValidation = useCallback((file: File) => {
    validatePdf(file)
      .then((result) => {
        setSlots((prev) =>
          prev.map((s) => {
            if (s.file !== file) return s;
            if (result.valid) {
              return { ...s, pageCount: result.pageCount, isValidating: false };
            }
            return { ...s, file: null, pageCount: null, error: result.error, isValidating: false };
          })
        );
      })
      .catch(() => {
        setSlots((prev) =>
          prev.map((s) => {
            if (s.file !== file) return s;
            return { ...s, file: null, pageCount: null, error: "This PDF can't be opened.", isValidating: false };
          })
        );
      });
  }, []);

  // --- Merge mode: Multi-file drop ---
  const handleFileDrop = useCallback(
    (targetIndex: number, rawFiles: File[]) => {
      if (locked) return;

      const isPdf = (f: File) =>
        f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf';

      const pdfFiles = rawFiles.filter(isPdf);
      const hasNonPdf = rawFiles.some((f) => !isPdf(f));

      if (pdfFiles.length === 0 && hasNonPdf) {
        setSlots((prev) =>
          prev.map((s, i) =>
            i === targetIndex
              ? { ...s, error: "This file isn't a PDF.", file: null, pageCount: null, isValidating: false }
              : s
          )
        );
        return;
      }

      const sorted = [...pdfFiles].sort((a, b) => naturalSortCompare(a.name, b.name));

      setSlots((prev) => {
        let newSlots = [...prev];
        let cursor = targetIndex;

        for (let fi = 0; fi < sorted.length; fi++) {
          const file = sorted[fi];

          if (fi === 0) {
            newSlots[cursor] = {
              ...newSlots[cursor],
              file,
              pageCount: null,
              error: null,
              isValidating: true,
            };
            cursor++;
          } else {
            while (cursor < newSlots.length && newSlots[cursor].file !== null) {
              cursor++;
            }

            if (cursor >= newSlots.length) {
              newSlots = [
                ...newSlots,
                {
                  id: crypto.randomUUID(),
                  number: newSlots.length + 1,
                  file,
                  pageCount: null,
                  error: null,
                  isValidating: true,
                },
              ];
              cursor = newSlots.length;
            } else {
              newSlots[cursor] = {
                ...newSlots[cursor],
                file,
                pageCount: null,
                error: null,
                isValidating: true,
              };
              cursor++;
            }
          }
        }

        return newSlots;
      });

      for (const file of sorted) {
        runValidation(file);
      }
    },
    [locked, runValidation]
  );

  // --- Merge mode: Click-to-browse single file ---
  const handleFileSelect = useCallback(
    (slotIndex: number, file: File) => {
      if (locked) return;

      const isPdf =
        file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';

      if (!isPdf) {
        setSlots((prev) =>
          prev.map((s, i) =>
            i === slotIndex
              ? { ...s, error: "This file isn't a PDF.", file: null, pageCount: null, isValidating: false }
              : s
          )
        );
        return;
      }

      setSlots((prev) =>
        prev.map((s, i) =>
          i === slotIndex
            ? { ...s, file, pageCount: null, error: null, isValidating: true }
            : s
        )
      );

      runValidation(file);
    },
    [locked, runValidation]
  );

  // --- Merge mode: Clear slot ---
  const handleClearSlot = useCallback(
    (slotIndex: number) => {
      if (locked) return;
      setSlots((prev) =>
        prev.map((s, i) =>
          i === slotIndex
            ? { ...s, file: null, pageCount: null, error: null, isValidating: false }
            : s
        )
      );
    },
    [locked]
  );

  // --- Merge mode: Add more slots ---
  const handleAddMore = useCallback(() => {
    if (locked) return;
    setSlots((prev) => [...prev, ...createSlots(SLOTS_ADD_STEP, prev.length + 1)]);
  }, [locked]);

  // --- Fix mode: File change ---
  const handleFixFileChange = useCallback(
    (file: File | null) => {
      if (locked) return;

      if (file === null) {
        setFixFile(null);
        setFixPageCount(null);
        setFixError(null);
        setFixIsValidating(false);
        return;
      }

      const isPdf =
        file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';

      if (!isPdf) {
        setFixFile(null);
        setFixPageCount(null);
        setFixError("This file isn't a PDF.");
        setFixIsValidating(false);
        return;
      }

      setFixFile(file);
      setFixPageCount(null);
      setFixError(null);
      setFixIsValidating(true);

      validatePdf(file)
        .then((result) => {
          if (result.valid) {
            setFixPageCount(result.pageCount);
            setFixIsValidating(false);
          } else {
            setFixFile(null);
            setFixPageCount(null);
            setFixError(result.error);
            setFixIsValidating(false);
          }
        })
        .catch(() => {
          setFixFile(null);
          setFixPageCount(null);
          setFixError("This PDF can't be opened.");
          setFixIsValidating(false);
        });
    },
    [locked]
  );

  // --- Fix mode: Add multiple files to queue ---
  const handleFixFilesAdd = useCallback(
    (files: File[]) => {
      if (locked) return;
      const pdfs = files.filter(
        (f) => f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf'
      );
      if (pdfs.length === 0) return;

      const newEntries: FixQueueEntry[] = pdfs.map((f) => ({
        id: crypto.randomUUID(),
        file: f,
        pageCount: null,
        error: null,
        isValidating: true,
        status: 'pending' as const,
      }));

      setFixFiles((prev) => [...prev, ...newEntries]);

      for (const entry of newEntries) {
        validatePdf(entry.file)
          .then((result) => {
            setFixFiles((prev) =>
              prev.map((e) =>
                e.id === entry.id
                  ? {
                      ...e,
                      pageCount: result.valid ? result.pageCount : null,
                      error: result.valid ? null : result.error,
                      isValidating: false,
                    }
                  : e
              )
            );
          })
          .catch(() => {
            setFixFiles((prev) =>
              prev.map((e) =>
                e.id === entry.id
                  ? { ...e, error: "This PDF can't be opened.", isValidating: false }
                  : e
              )
            );
          });
      }
    },
    [locked]
  );

  // --- Fix mode: Remove file from queue ---
  const handleFixFileRemove = useCallback(
    (id: string) => {
      if (locked) return;
      setFixFiles((prev) => prev.filter((e) => e.id !== id));
    },
    [locked]
  );

  // --- Replace mode: File change ---
  const handleReplaceFileChange = useCallback(
    (file: File | null) => {
      if (locked) return;

      // Clean up previous PDF and its cached thumbnails
      clearExtraction();
      if (replacePdf) {
        clearThumbnailCache(replacePdf);
        replacePdf.destroy();
      }
      setReplacePdf(null);
      setReplacements(new Map());
      setDeletions(new Set());
      setInsertions([]);
      setPageOrder([]);
      setSelectedPages(new Set());

      if (file === null) {
        setReplaceFile(null);
        setReplacePageCount(null);
        setReplaceError(null);
        setReplaceIsValidating(false);
        return;
      }

      const isPdf =
        file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';

      if (!isPdf) {
        setReplaceFile(null);
        setReplacePageCount(null);
        setReplaceError("This file isn't a PDF.");
        setReplaceIsValidating(false);
        return;
      }

      setReplaceFile(file);
      setReplacePageCount(null);
      setReplaceError(null);
      setReplaceIsValidating(true);

      validatePdf(file)
        .then((result) => {
          if (result.valid) {
            setReplacePageCount(result.pageCount);
            setPageOrder(Array.from({ length: result.pageCount }, (_, i) => i + 1));
            setReplaceIsValidating(false);
            // Load PDFDocumentProxy for thumbnail rendering, then pdf-lib for fast JPEG extraction
            loadPdfDocument(file).then((pdf) => {
              setReplacePdf(pdf);
              // Load pdf-lib extraction using pdfjs fingerprint for identity gating
              file.arrayBuffer().then((ab) =>
                loadForExtraction(new Uint8Array(ab), pdf.fingerprints[0] ?? '')
              ).catch(() => { /* extraction is optional, pdfjs fallback works */ });
            }).catch(() => {
              setReplaceError("Failed to load PDF for preview.");
            });
          } else {
            setReplaceFile(null);
            setReplacePageCount(null);
            setReplaceError(result.error);
            setReplaceIsValidating(false);
          }
        })
        .catch(() => {
          setReplaceFile(null);
          setReplacePageCount(null);
          setReplaceError("This PDF can't be opened.");
          setReplaceIsValidating(false);
        });
    },
    [locked, replacePdf]
  );

  // --- Replace mode: Page replacement ---
  const handleReplace = useCallback((pageNumber: number, file: File) => {
    setReplacements((prev) => new Map(prev).set(pageNumber, file));
  }, []);

  const handleUndoReplace = useCallback((pageNumber: number) => {
    setReplacements((prev) => {
      const next = new Map(prev);
      next.delete(pageNumber);
      return next;
    });
  }, []);

  // --- Replace mode: Delete page ---
  const handleDelete = useCallback((pageNumber: number) => {
    setDeletions((prev) => new Set(prev).add(pageNumber));
    // Deleting a replaced page clears the replacement
    setReplacements((prev) => {
      if (!prev.has(pageNumber)) return prev;
      const next = new Map(prev);
      next.delete(pageNumber);
      return next;
    });
  }, []);

  const handleUndoDelete = useCallback((pageNumber: number) => {
    setDeletions((prev) => {
      const next = new Set(prev);
      next.delete(pageNumber);
      return next;
    });
  }, []);

  // --- Replace mode: Insert page ---
  const handleInsert = useCallback((afterPage: number, file: File) => {
    setInsertions((prev) => [
      ...prev,
      { afterPage, file, id: crypto.randomUUID() },
    ]);
  }, []);

  const handleRemoveInsert = useCallback((id: string) => {
    setInsertions((prev) => prev.filter((ins) => ins.id !== id));
  }, []);

  // --- Replace mode: Selection & Move ---
  const handleToggleSelect = useCallback((pageNumber: number) => {
    setSelectedPages((prev) => {
      const next = new Set(prev);
      if (next.has(pageNumber)) {
        next.delete(pageNumber);
      } else {
        next.add(pageNumber);
      }
      return next;
    });
  }, []);

  const handleMoveTo = useCallback((afterPage: number) => {
    setPageOrder((prev) => {
      const selected = Array.from(selectedPages);
      // Remove selected pages from current order
      const remaining = prev.filter((pn) => !selectedPages.has(pn));
      // Find insertion point: after the page number `afterPage` in the remaining list
      let insertIdx: number;
      if (afterPage === 0) {
        insertIdx = 0;
      } else {
        const idx = remaining.indexOf(afterPage);
        insertIdx = idx >= 0 ? idx + 1 : remaining.length;
      }
      // Preserve relative order of selected pages from original order
      const selectedInOrder = prev.filter((pn) => selectedPages.has(pn));
      const result = [...remaining];
      result.splice(insertIdx, 0, ...selectedInOrder);
      return result;
    });
    setSelectedPages(new Set());
  }, [selectedPages]);

  const handleClearSelection = useCallback(() => {
    setSelectedPages(new Set());
  }, []);

  const handleResetOrder = useCallback(() => {
    if (replacePageCount) {
      setPageOrder(Array.from({ length: replacePageCount }, (_, i) => i + 1));
    }
    setSelectedPages(new Set());
  }, [replacePageCount]);

  const handlePageClick = useCallback((pageNumber: number) => {
    setViewingPage(pageNumber);
  }, []);

  const handleOpenFullscreen = useCallback((initialPage?: number) => {
    setViewingPage(null);
    setFullscreenOpen(true);
  }, []);

  // --- Clean up PDFs on unmount ---
  useEffect(() => {
    return () => {
      clearExtraction();
      if (replacePdf) {
        clearThumbnailCache(replacePdf);
        replacePdf.destroy();
      }
    };
  }, [replacePdf]);

  // --- Auto-download audit TXT for multi-book when issues found ---
  const downloadAuditTxt = useCallback(async (auditUrl: string, bookFilename: string) => {
    try {
      const res = await fetch(auditUrl);
      if (!res.ok) return;
      const data = await res.json() as {
        summary: string;
        issues: { type: string; confidence: string; message: string }[];
        pages: { scan: number; printed: string | null; kind: string; source: string; blank: boolean }[];
      };
      if (!data.issues || data.issues.length === 0) return;

      // Build readable TXT
      const lines: string[] = [];
      const name = bookFilename.replace(/\.pdf$/i, '');
      lines.push(`Page Audit Report: ${bookFilename}`);
      lines.push('='.repeat(40));
      lines.push('');
      lines.push(`Summary: ${data.summary}`);
      lines.push('');
      lines.push(`Issues (${data.issues.length}):`);
      for (const issue of data.issues) {
        const tag = issue.confidence === 'high' ? 'HIGH' : 'LOW';
        const prefix = issue.type === 'info' ? 'INFO' : tag;
        lines.push(`  [${prefix}] ${issue.message}`);
      }

      if (data.pages && data.pages.length > 0) {
        lines.push('');
        lines.push('Page mapping:');
        for (const p of data.pages) {
          const printed = p.printed ?? '(unnumbered)';
          const flags: string[] = [];
          if (p.blank) flags.push('blank');
          if (p.source === 'infer') flags.push('inferred');
          const suffix = flags.length > 0 ? `  [${flags.join(', ')}]` : '';
          lines.push(`  Scan ${String(p.scan).padStart(4)} → ${printed}${suffix}`);
        }
      }

      lines.push('');
      const blob = new Blob([lines.join('\n')], { type: 'text/plain; charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${name}_audit.txt`;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => { document.body.removeChild(link); URL.revokeObjectURL(url); }, 300);
    } catch {
      // Non-critical — don't block the pipeline
    }
  }, []);

  // --- Start processing ---
  const handleStart = useCallback(async () => {
    if (!canStart) return;

    if (mode === 'merge') {
      // Check for empty slots between filled ones
      const filledIndices = slots
        .map((s, i) => (s.file ? i : -1))
        .filter((i) => i >= 0);

      if (filledIndices.length === 0) return;

      const first = filledIndices[0];
      const last = filledIndices[filledIndices.length - 1];

      const emptyBetween = slots
        .slice(first, last + 1)
        .filter((s) => !s.file)
        .map((s) => s.number);

      if (emptyBetween.length > 0) {
        const slotList = emptyBetween.map((n) => `Slot ${n}`).join(', ');
        const message =
          emptyBetween.length === 1
            ? `${slotList} is empty. Continue anyway?`
            : `${slotList} are empty. Continue anyway?`;

        if (!window.confirm(message)) return;
      }
    }

    // Start processing
    setStatus('processing');
    setProgress({ current: 0, total: 0 });
    setProgressPhase('preparing');
    setErrorMessage(null);
    setResultAngles([]);
    cancelRef.current = { cancelled: false };

    try {
      const progressCb = (p: { phase: PipelinePhase; current: number; total: number }) => {
        setProgressPhase(p.phase);
        setProgress({ current: p.current, total: p.total });
      };

      let result;
      if (mode === 'merge') {
        result = await runMergeOnlyPipeline(slots, bookName, progressCb, cancelRef.current);
      } else if (mode === 'replace') {
        const name = replaceFile!.name.replace(/\.pdf$/i, '');
        result = await runReplacePipeline(replaceFile!, replacements, deletions, insertions, pageOrder, name, progressCb, cancelRef.current);
      } else {
        // Full Book Fix: process queue sequentially
        const queue = fixFiles.length > 0
          ? fixFiles.filter((f) => !f.error && f.pageCount !== null)
          : fixFile ? [{ id: 'single', file: fixFile, pageCount: fixPageCount, error: null, isValidating: false, status: 'pending' as const }] : [];

        for (let qi = 0; qi < queue.length; qi++) {
          if (cancelRef.current.cancelled) throw new Error('Cancelled');
          const entry = queue[qi];
          const label = queue.length > 1
            ? `Book ${qi + 1} of ${queue.length}: ${entry.file.name}`
            : entry.file.name;
          setFixQueueLabel(label);
          setFixFiles((prev) =>
            prev.map((e) => e.id === entry.id ? { ...e, status: 'processing' } : e)
          );
          const name = entry.file.name.replace(/\.pdf$/i, '');
          result = await runFullfixPipeline(
            entry.file, name,
            { straighten: fullfixStraighten, clean: fullfixClean, dewarp: fullfixDewarp, v2: fullfixV2, skipClean: fullfixSkipClean.trim() || undefined, ocr: fullfixOcr, skipStraighten: fullfixSkipStraighten.trim() || undefined, skipDewarp: fullfixSkipDewarp.trim() || undefined, audit: fullfixAudit },
            progressCb, cancelRef.current
          );
          setFixFiles((prev) =>
            prev.map((e) => e.id === entry.id ? { ...e, status: 'done' } : e)
          );

          // Multi-book: auto-download audit TXT if discrepancies found
          if (fullfixAudit && queue.length > 1 && result?.downloadUrl) {
            const auditUrl = `${result.downloadUrl}&type=audit`;
            await downloadAuditTxt(auditUrl, entry.file.name);
          }
        }
        setFixQueueLabel('');
      }

      // Clean up old URL if any
      if (downloadUrl && downloadUrl.startsWith('blob:')) URL.revokeObjectURL(downloadUrl);

      if (result) {
        const url = result.downloadUrl ?? URL.createObjectURL(result.blob);
        setDownloadUrl(url);
        setDownloadFilename(result.filename);
        setResultTotalPages(result.totalPages);
        setResultAngles(result.angles);
      }
      setStatus('done');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'Cancelled') {
        setStatus('idle');
      } else {
        setErrorMessage(message);
        setStatus('error');
      }
    }
  }, [canStart, mode, slots, bookName, fixFile, fixPageCount, fixFiles, replaceFile, replacements, deletions, insertions, downloadUrl, fullfixStraighten, fullfixClean, fullfixDewarp, fullfixV2, fullfixSkipClean, fullfixSkipStraighten, fullfixSkipDewarp, fullfixOcr, fullfixAudit, downloadAuditTxt]);

  // --- Cancel ---
  const handleCancel = useCallback(() => {
    cancelRef.current.cancelled = true;
  }, []);

  // --- Start over ---
  const handleStartOver = useCallback(() => {
    if (downloadUrl && downloadUrl.startsWith('blob:')) URL.revokeObjectURL(downloadUrl);
    setDownloadUrl(null);
    setDownloadFilename('');
    setResultTotalPages(0);
    setResultAngles([]);
    setStatus('idle');
    setProgress({ current: 0, total: 0 });
    setProgressPhase('preparing');
    setErrorMessage(null);
    setBookName('');
    setSlots(createSlots(SLOTS_DEFAULT, 1));
    setFixFile(null);
    setFixPageCount(null);
    setFixError(null);
    setFixIsValidating(false);
    setFixFiles([]);
    setFixQueueLabel('');
    if (replacePdf) replacePdf.destroy();
    setReplacePdf(null);
    setReplaceFile(null);
    setReplacePageCount(null);
    setReplaceError(null);
    setReplaceIsValidating(false);
    setReplacements(new Map());
    setDeletions(new Set());
    setInsertions([]);
  }, [downloadUrl, replacePdf]);

  // --- Derived values ---
  const totalPages = slots.reduce((sum, s) => sum + (s.pageCount ?? 0), 0);
  const filledCount = slots.filter((s) => s.file !== null).length;
  const replaceOutputPages = (replacePageCount ?? 0) - deletions.size + insertions.length;
  const showStickyDownload = mode === 'replace' && replacePdf !== null && canStartReplace && status === 'idle';

  const subtitleText =
    mode === 'merge'
      ? 'Merge your scanned book pages into one PDF'
      : mode === 'replace'
        ? 'Replace specific pages in an existing PDF'
        : 'Straighten, clean, and dewarp your scanned book PDF';

  // --- Start button hint ---
  let startHint = '';
  if (!canStart && status === 'idle') {
    if (mode === 'merge') {
      if (bookName.trim().length === 0 && !slots.some((s) => s.file !== null)) {
        startHint = 'Enter a book name and add at least one PDF to start.';
      } else if (bookName.trim().length === 0) {
        startHint = 'Enter a book name above to start.';
      } else if (!slots.some((s) => s.file !== null)) {
        startHint = 'Add at least one PDF file to start.';
      } else if (slots.some((s) => s.isValidating)) {
        startHint = 'Validating files...';
      }
    } else if (mode === 'replace') {
      if (replaceFile === null) {
        startHint = 'Add a PDF file to get started.';
      } else if (replaceIsValidating) {
        startHint = 'Validating file...';
      } else if (replacements.size === 0 && deletions.size === 0 && insertions.length === 0) {
        startHint = 'Replace, delete, or insert pages to get started.';
      }
    } else {
      if (!fullfixStraighten && !fullfixClean && !fullfixDewarp && !fullfixV2 && !fullfixOcr) {
        startHint = 'Select at least one option above.';
      } else if (fixFiles.length === 0 && fixFile === null) {
        startHint = 'Add one or more PDF files to start.';
      } else if (fixFiles.some((f) => f.isValidating)) {
        startHint = 'Validating files...';
      }
    }
  }

  return (
    <>
    <main
      className="flex-1 w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12"
      style={{ maxWidth: '56rem' }}
    >
      {/* Header */}
      <header className="text-center mb-8 sm:mb-10">
        <h1
          className="text-4xl sm:text-5xl font-bold tracking-tight"
          style={{ color: 'var(--color-ink)' }}
        >
          Straight Up
        </h1>
        <p
          className="mt-3 text-base sm:text-lg"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {subtitleText}
        </p>
        <p
          className="mt-1 text-xs"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          Everything happens in your browser — no files are uploaded anywhere.
        </p>
      </header>

      {/* Mode tabs */}
      <section className="flex justify-center mb-8 sm:mb-10">
        <div
          className="inline-flex p-1"
          style={{
            background: 'var(--color-surface-inset)',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--color-border)',
          }}
        >
          {([
            { key: 'merge' as ToolMode, label: 'Merge' },
            { key: 'fullfix' as ToolMode, label: 'Full Book Fix' },
            { key: 'replace' as ToolMode, label: 'Replace Pages' },
          ]).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => handleModeChange(tab.key)}
              disabled={locked}
              className="focus-ring px-5 py-2 text-sm font-medium transition-all"
              style={{
                background: mode === tab.key ? 'var(--color-primary)' : 'transparent',
                color: mode === tab.key ? '#ffffff' : 'var(--color-ink-muted)',
                borderRadius: 'var(--radius-md)',
                border: 'none',
                cursor: locked ? 'not-allowed' : 'pointer',
                opacity: locked && mode !== tab.key ? 0.5 : 1,
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </section>

      {/* Book name input (only shown in merge mode) */}
      {mode === 'merge' && (
        <section className="mx-auto mb-8 sm:mb-10" style={{ maxWidth: '28rem' }}>
          <BookNameInput value={bookName} onChange={setBookName} disabled={locked} />
        </section>
      )}

      {/* Input area — mode-dependent */}
      {mode === 'merge' ? (
        <section className="mb-8 sm:mb-10">
          <div className="flex items-center justify-between mb-4">
            <h2
              className="text-sm font-semibold uppercase tracking-wider"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              PDF files
            </h2>
            {filledCount > 0 && (
              <span
                className="text-xs font-medium px-2.5 py-1"
                style={{
                  background: 'var(--color-primary-subtle)',
                  color: 'var(--color-primary)',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                {filledCount} {filledCount === 1 ? 'file' : 'files'} · {totalPages}{' '}
                {totalPages === 1 ? 'page' : 'pages'}
              </span>
            )}
          </div>

          <SlotGrid
            slots={slots}
            locked={locked}
            onFileDrop={handleFileDrop}
            onFileSelect={handleFileSelect}
            onClearSlot={handleClearSlot}
          />

          <div className="flex justify-center mt-5">
            <button
              type="button"
              onClick={handleAddMore}
              disabled={locked}
              className="focus-ring flex items-center gap-1.5 px-5 py-2.5 text-sm font-medium transition-all"
              style={{
                background: 'transparent',
                border: '1.5px dashed var(--color-border-strong)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--color-ink-muted)',
                cursor: locked ? 'not-allowed' : 'pointer',
                opacity: locked ? 0.5 : 1,
              }}
              onMouseEnter={(e) => {
                if (!locked) {
                  e.currentTarget.style.borderColor = 'var(--color-primary)';
                  e.currentTarget.style.color = 'var(--color-primary)';
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-border-strong)';
                e.currentTarget.style.color = 'var(--color-ink-muted)';
              }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="7" y1="1" x2="7" y2="13" />
                <line x1="1" y1="7" x2="13" y2="7" />
              </svg>
              Add more slots
            </button>
          </div>

        </section>
      ) : mode === 'replace' ? (
        <section className="mb-8 sm:mb-10">
          {/* Before PDF loaded: show drop zone */}
          {!replacePdf && (
            <div className="mx-auto" style={{ maxWidth: '32rem' }}>
              <h2
                className="text-sm font-semibold uppercase tracking-wider mb-4"
                style={{ color: 'var(--color-ink-muted)' }}
              >
                PDF file
              </h2>
              <FixDropZone
                file={replaceFile}
                pageCount={replacePageCount}
                error={replaceError}
                isValidating={replaceIsValidating}
                locked={locked}
                onFileChange={handleReplaceFileChange}
              />
            </div>
          )}

          {/* After PDF loaded: show page grid */}
          {replacePdf && replacePageCount && (
            <PageGrid
              pdf={replacePdf}
              totalPages={replacePageCount}
              replacements={replacements}
              deletions={deletions}
              insertions={insertions}
              locked={locked}
              pageOrder={pageOrder}
              selectedPages={selectedPages}
              onPageClick={handlePageClick}
              onReplace={handleReplace}
              onUndoReplace={handleUndoReplace}
              onDelete={handleDelete}
              onUndoDelete={handleUndoDelete}
              onInsert={handleInsert}
              onRemoveInsert={handleRemoveInsert}
              onOpenFullscreen={handleOpenFullscreen}
              onToggleSelect={handleToggleSelect}
              onMoveTo={handleMoveTo}
              onClearSelection={handleClearSelection}
              onResetOrder={handleResetOrder}
            />
          )}
        </section>
      ) : (
        <section className="mx-auto mb-8 sm:mb-10" style={{ maxWidth: '32rem' }}>
          <h2
            className="text-sm font-semibold uppercase tracking-wider mb-4"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            PDF files
          </h2>
          <FixDropZone
            file={fixFiles.length > 0 ? null : fixFile}
            pageCount={fixFiles.length > 0 ? null : fixPageCount}
            error={fixFiles.length > 0 ? null : fixError}
            isValidating={fixFiles.length > 0 ? false : fixIsValidating}
            locked={locked}
            onFileChange={handleFixFileChange}
            multiple
            onMultiFileAdd={handleFixFilesAdd}
          />

          {/* File queue list */}
          {fixFiles.length > 0 && (
            <div
              className="mt-3 flex flex-col gap-1"
              style={{
                background: 'var(--color-surface-card)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-lg)',
                overflow: 'hidden',
              }}
            >
              {fixFiles.map((entry, idx) => (
                <div
                  key={entry.id}
                  className="flex items-center gap-3 px-4 py-2.5"
                  style={{
                    borderBottom: idx < fixFiles.length - 1 ? '1px solid var(--color-border)' : 'none',
                    opacity: entry.status === 'done' ? 0.6 : entry.error ? 0.5 : 1,
                  }}
                >
                  {/* Status icon */}
                  {entry.status === 'done' ? (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--color-success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <polyline points="3 8 6.5 11.5 13 5" />
                    </svg>
                  ) : entry.status === 'processing' ? (
                    <div
                      className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin"
                      style={{ borderColor: 'var(--color-primary)', borderTopColor: 'transparent', flexShrink: 0 }}
                    />
                  ) : entry.error ? (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--color-danger)" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}>
                      <line x1="4" y1="4" x2="12" y2="12" />
                      <line x1="12" y1="4" x2="4" y2="12" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-ink-subtle)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                  )}

                  {/* Filename + page count */}
                  <div className="flex-1 min-w-0">
                    <p
                      className="text-sm truncate"
                      style={{ color: entry.error ? 'var(--color-danger)' : 'var(--color-ink)' }}
                      title={entry.file.name}
                    >
                      {entry.file.name}
                    </p>
                    {entry.error && (
                      <p className="text-xs" style={{ color: 'var(--color-danger)' }}>{entry.error}</p>
                    )}
                  </div>

                  {/* Page count badge */}
                  {entry.pageCount !== null && !entry.error && (
                    <span
                      className="text-xs font-medium px-2 py-0.5"
                      style={{
                        background: 'var(--color-accent-subtle)',
                        color: 'var(--color-accent-hover)',
                        borderRadius: 'var(--radius-sm)',
                        flexShrink: 0,
                      }}
                    >
                      {entry.pageCount} pg
                    </span>
                  )}

                  {entry.isValidating && (
                    <div
                      className="w-3 h-3 rounded-full border-2 border-t-transparent animate-spin"
                      style={{ borderColor: 'var(--color-primary)', borderTopColor: 'transparent', flexShrink: 0 }}
                    />
                  )}

                  {/* Remove button (only when pending and not locked) */}
                  {entry.status === 'pending' && !locked && (
                    <button
                      type="button"
                      onClick={() => handleFixFileRemove(entry.id)}
                      className="focus-ring flex items-center justify-center w-6 h-6"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--color-ink-subtle)',
                        cursor: 'pointer',
                        flexShrink: 0,
                        padding: 0,
                      }}
                      aria-label={`Remove ${entry.file.name}`}
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <line x1="2" y1="2" x2="10" y2="10" />
                        <line x1="10" y1="2" x2="2" y2="10" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Fix options */}
          <div
            className="mt-5 p-4 flex flex-col gap-3"
            style={{
              background: 'var(--color-surface-card)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-lg)',
            }}
          >
            <div className="flex items-center justify-between">
              <p
                className="text-xs font-semibold uppercase tracking-wider"
                style={{ color: 'var(--color-ink-muted)' }}
              >
                Options
              </p>
              <label
                className="flex items-center gap-2 cursor-pointer select-none"
                style={{ opacity: locked ? 0.5 : 1 }}
              >
                <input
                  type="checkbox"
                  checked={fullfixV2 && fullfixClean && fullfixOcr && fullfixAudit}
                  ref={(el) => {
                    if (el) {
                      const count = [fullfixV2, fullfixClean, fullfixOcr, fullfixAudit].filter(Boolean).length;
                      el.indeterminate = count > 0 && count < 4;
                    }
                  }}
                  onChange={(e) => {
                    const v = e.target.checked;
                    setFullfixV2(v);
                    setFullfixClean(v);
                    setFullfixOcr(v);
                    setFullfixAudit(v);
                  }}
                  disabled={locked}
                  className="accent-[var(--color-primary)]"
                  style={{ width: 16, height: 16 }}
                />
                <span className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>All</span>
              </label>
            </div>
            <label
              className="flex items-center gap-3 cursor-pointer select-none"
              style={{ opacity: locked ? 0.5 : 1 }}
            >
              <input
                type="checkbox"
                checked={fullfixV2}
                onChange={(e) => setFullfixV2(e.target.checked)}
                disabled={locked}
                className="accent-[var(--color-primary)]"
                style={{ width: 18, height: 18 }}
              />
              <div className="flex flex-col">
                <span className="text-sm" style={{ color: 'var(--color-ink)' }}>
                  Straighten & Dewarp v2
                </span>
                <span className="text-xs" style={{ color: 'var(--color-ink-subtle)' }}>
                  Perspective correction, text-line dewarping, column alignment
                </span>
              </div>
            </label>
            {fullfixV2 && (
              <div className="ml-9">
                <label
                  className="flex flex-col gap-1"
                  style={{ opacity: locked ? 0.5 : 1 }}
                >
                  <span className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>
                    Skip straighten/dewarp on pages (comma-separated)
                  </span>
                  <input
                    type="text"
                    value={fullfixSkipStraighten}
                    onChange={(e) => setFullfixSkipStraighten(e.target.value)}
                    disabled={locked}
                    placeholder="e.g. 1, 3, 5"
                    className="text-sm px-3 py-1.5"
                    style={{
                      background: 'var(--color-surface-inset)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-md)',
                      color: 'var(--color-ink)',
                      outline: 'none',
                      width: '100%',
                      maxWidth: '14rem',
                    }}
                  />
                </label>
              </div>
            )}
            <label
              className="flex items-center gap-3 cursor-pointer select-none"
              style={{ opacity: locked ? 0.5 : 1 }}
            >
              <input
                type="checkbox"
                checked={fullfixClean}
                onChange={(e) => setFullfixClean(e.target.checked)}
                disabled={locked}
                className="accent-[var(--color-primary)]"
                style={{ width: 18, height: 18 }}
              />
              <span className="text-sm" style={{ color: 'var(--color-ink)' }}>
                Clean background
              </span>
            </label>
            {fullfixClean && (
              <div className="ml-9">
                <label
                  className="flex flex-col gap-1"
                  style={{ opacity: locked ? 0.5 : 1 }}
                >
                  <span className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>
                    Skip pages — leave as-is (comma-separated)
                  </span>
                  <input
                    type="text"
                    value={fullfixSkipClean}
                    onChange={(e) => setFullfixSkipClean(e.target.value)}
                    disabled={locked}
                    placeholder="e.g. 1, 3, 5"
                    className="text-sm px-3 py-1.5"
                    style={{
                      background: 'var(--color-surface-inset)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-md)',
                      color: 'var(--color-ink)',
                      outline: 'none',
                      width: '100%',
                      maxWidth: '14rem',
                    }}
                  />
                </label>
              </div>
            )}
            <label
              className="flex items-center gap-3 cursor-pointer select-none"
              style={{ opacity: locked ? 0.5 : 1 }}
            >
              <input
                type="checkbox"
                checked={fullfixOcr}
                onChange={(e) => setFullfixOcr(e.target.checked)}
                disabled={locked}
                className="accent-[var(--color-primary)]"
                style={{ width: 18, height: 18 }}
              />
              <div className="flex flex-col">
                <span className="text-sm" style={{ color: 'var(--color-ink)' }}>
                  OCR (text recognition)
                </span>
                <span className="text-xs" style={{ color: 'var(--color-ink-subtle)' }}>
                  Extract searchable text from scanned pages
                </span>
              </div>
            </label>
            <label
              className="flex items-center gap-3 cursor-pointer select-none"
              style={{ opacity: locked ? 0.5 : 1 }}
            >
              <input
                type="checkbox"
                checked={fullfixAudit}
                onChange={(e) => setFullfixAudit(e.target.checked)}
                disabled={locked}
                className="accent-[var(--color-primary)]"
                style={{ width: 18, height: 18 }}
              />
              <div className="flex flex-col">
                <span className="text-sm" style={{ color: 'var(--color-ink)' }}>
                  Check discrepancies
                </span>
                <span className="text-xs" style={{ color: 'var(--color-ink-subtle)' }}>
                  Detect missing or duplicate pages after processing
                </span>
              </div>
            </label>
          </div>
        </section>
      )}

      {/* Start button (hidden during processing/done, hidden in replace mode when sticky bar shown) */}
      {status === 'idle' && !showStickyDownload && (
        <section className="flex flex-col items-center mb-8">
          <button
            type="button"
            onClick={handleStart}
            disabled={!canStart}
            className="focus-ring w-full px-8 py-4 text-lg font-semibold transition-all"
            style={{
              maxWidth: '24rem',
              background: canStart ? 'var(--color-primary)' : 'var(--color-border)',
              color: canStart ? '#ffffff' : 'var(--color-ink-subtle)',
              borderRadius: 'var(--radius-lg)',
              border: 'none',
              cursor: canStart ? 'pointer' : 'not-allowed',
              boxShadow: canStart ? 'var(--shadow-md)' : 'none',
            }}
            onMouseEnter={(e) => {
              if (canStart) {
                e.currentTarget.style.background = 'var(--color-primary-hover)';
                e.currentTarget.style.boxShadow = 'var(--shadow-lg)';
              }
            }}
            onMouseLeave={(e) => {
              if (canStart) {
                e.currentTarget.style.background = 'var(--color-primary)';
                e.currentTarget.style.boxShadow = 'var(--shadow-md)';
              }
            }}
          >
            {mode === 'replace' ? 'Download' : 'Start'}
          </button>
          {startHint && (
            <p className="mt-2 text-xs" style={{ color: 'var(--color-ink-subtle)' }}>
              {startHint}
            </p>
          )}
        </section>
      )}

      {/* Progress panel */}
      {status === 'processing' && (
        <section className="mb-8">
          {fixQueueLabel && (
            <p
              className="text-center text-sm font-medium mb-3"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              {fixQueueLabel}
            </p>
          )}
          <ProgressPanel
            phase={progressPhase}
            current={progress.current}
            total={progress.total}
            onCancel={handleCancel}
          />
        </section>
      )}

      {/* Result panel */}
      {status === 'done' && (
        <section className="mb-8">
          {mode === 'fullfix' && fixFiles.filter((f) => f.status === 'done').length > 1 ? (
            /* Multi-book done summary */
            <div
              className="w-full mx-auto flex flex-col items-center gap-5"
              style={{ maxWidth: '36rem' }}
            >
              <div
                className="w-full p-6 sm:p-8 flex flex-col items-center gap-5"
                style={{
                  background: 'var(--color-surface-card)',
                  border: '1.5px solid var(--color-border)',
                  borderRadius: 'var(--radius-xl)',
                  boxShadow: 'var(--shadow-md)',
                }}
              >
                <div
                  className="flex items-center justify-center w-14 h-14"
                  style={{ background: 'oklch(92% 0.06 155)', borderRadius: '50%' }}
                >
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-success)' }}>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <div className="text-center">
                  <p className="text-base font-semibold" style={{ color: 'var(--color-ink)' }}>
                    All books processed
                  </p>
                  <p className="mt-1 text-sm" style={{ color: 'var(--color-ink-muted)' }}>
                    {fixFiles.filter((f) => f.status === 'done').length} books downloaded
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleStartOver}
                  className="focus-ring px-5 py-2 text-sm font-medium transition-colors"
                  style={{
                    background: 'transparent',
                    border: '1.5px solid var(--color-border-strong)',
                    borderRadius: 'var(--radius-md)',
                    color: 'var(--color-ink-muted)',
                    cursor: 'pointer',
                  }}
                >
                  Start over
                </button>
              </div>
            </div>
          ) : downloadUrl ? (
            <ResultPanel
              filename={downloadFilename}
              totalPages={resultTotalPages}
              downloadUrl={downloadUrl}
              angles={resultAngles}
              ocrEnabled={mode === 'fullfix' && fullfixOcr}
              auditEnabled={mode === 'fullfix' && fullfixAudit}
              onStartOver={handleStartOver}
            />
          ) : (
            /* Done but no download URL (e.g. all-queue done with native downloads) */
            <div className="flex justify-center">
              <button
                type="button"
                onClick={handleStartOver}
                className="focus-ring px-5 py-2.5 text-sm font-medium transition-colors"
                style={{
                  background: 'transparent',
                  border: '1.5px solid var(--color-border-strong)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--color-ink-muted)',
                  cursor: 'pointer',
                }}
              >
                Start over
              </button>
            </div>
          )}
        </section>
      )}

      {/* Error state */}
      {status === 'error' && (
        <section className="flex justify-center mb-8">
          <div
            className="w-full mx-auto p-6 flex flex-col items-center gap-4"
            style={{
              maxWidth: '28rem',
              background: 'var(--color-danger-subtle)',
              border: '1.5px solid var(--color-danger)',
              borderRadius: 'var(--radius-xl)',
            }}
          >
            <p className="text-sm font-medium" style={{ color: 'var(--color-danger)' }}>
              Something went wrong
            </p>
            {errorMessage && (
              <p className="text-xs text-center" style={{ color: 'var(--color-ink-muted)' }}>
                {errorMessage}
              </p>
            )}
            <button
              type="button"
              onClick={handleStartOver}
              className="focus-ring px-5 py-2 text-sm font-medium transition-colors"
              style={{
                background: 'transparent',
                border: '1.5px solid var(--color-border-strong)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--color-ink-muted)',
                cursor: 'pointer',
              }}
            >
              Start over
            </button>
          </div>
        </section>
      )}
      {/* Bottom spacer when sticky bar is visible */}
      {showStickyDownload && <div style={{ height: 72 }} />}

      {/* Sticky download bar for replace mode */}
      {showStickyDownload && (
        <div
          style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            padding: '12px 16px',
            background: 'var(--color-surface-card)',
            borderTop: '1px solid var(--color-border)',
            boxShadow: '0 -4px 12px oklch(0% 0 0 / 0.08)',
            zIndex: 50,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: '16px',
          }}
        >
          <span
            className="text-xs font-medium px-2.5 py-1"
            style={{
              background: 'var(--color-primary-subtle)',
              color: 'var(--color-primary)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            {replaceOutputPages} output {replaceOutputPages === 1 ? 'page' : 'pages'}
          </span>
          <button
            type="button"
            onClick={handleStart}
            className="focus-ring flex items-center gap-2 px-6 py-2.5 text-sm font-semibold transition-all"
            style={{
              background: 'var(--color-primary)',
              color: '#fff',
              borderRadius: 'var(--radius-lg)',
              border: 'none',
              cursor: 'pointer',
              boxShadow: 'var(--shadow-md)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--color-primary-hover)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--color-primary)';
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download
          </button>
        </div>
      )}
    </main>

    {/* Page View Modal */}
    {viewingPage !== null && replacePdf && replacePageCount && (
      <PageViewModal
        pdf={replacePdf}
        pageNumber={viewingPage}
        totalPages={replacePageCount}
        replacement={replacements.get(viewingPage) ?? null}
        isDeleted={deletions.has(viewingPage)}
        onClose={() => setViewingPage(null)}
        onNavigate={(pn) => setViewingPage(pn)}
        onOpenFullscreen={(pn) => {
          setViewingPage(null);
          setFullscreenOpen(true);
        }}
      />
    )}

    {/* Fullscreen Viewer */}
    {fullscreenOpen && replacePdf && replacePageCount && (
      <FullscreenViewer
        pdf={replacePdf}
        totalPages={replacePageCount}
        replacements={replacements}
        deletions={deletions}
        insertions={insertions}
        locked={locked}
        pageOrder={pageOrder}
        selectedPages={selectedPages}
        onClose={() => setFullscreenOpen(false)}
        onReplace={handleReplace}
        onUndoReplace={handleUndoReplace}
        onDelete={handleDelete}
        onUndoDelete={handleUndoDelete}
        onInsert={handleInsert}
        onRemoveInsert={handleRemoveInsert}
        onToggleSelect={handleToggleSelect}
        onMoveTo={handleMoveTo}
        onClearSelection={handleClearSelection}
      />
    )}
    </>
  );
}
