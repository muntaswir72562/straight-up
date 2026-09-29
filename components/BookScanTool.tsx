'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { SlotData, AppStatus, Progress } from '@/lib/types';
import { SLOTS_DEFAULT, SLOTS_ADD_STEP } from '@/lib/constants';
import { naturalSortCompare } from '@/lib/naturalSort';
import { validatePdf, loadPdfDocument } from '@/lib/pdf/render';
import { runMergeOnlyPipeline, type PageAngleInfo, type PipelinePhase } from '@/lib/pipeline';
import { runReplacePipeline } from '@/lib/replacePipeline';
import { runFullfixPipeline } from '@/lib/fullfixPipeline';
import { runMergeV2Pipeline } from '@/lib/straightenPipeline';
import { BookNameInput } from './BookNameInput';
import { SlotGrid } from './SlotGrid';
import { FixDropZone } from './FixDropZone';
import { PageGrid } from './PageGrid';
import { ProgressPanel } from './ProgressPanel';
import { ResultPanel } from './ResultPanel';

type ToolMode = 'merge' | 'fullfix' | 'replace';

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
  const [mergeV2, setMergeV2] = useState(false);

  // --- Full fix mode state ---
  const [fixFile, setFixFile] = useState<File | null>(null);
  const [fixPageCount, setFixPageCount] = useState<number | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const [fixIsValidating, setFixIsValidating] = useState(false);
  const [fullfixStraighten, setFullfixStraighten] = useState(false);
  const [fullfixClean, setFullfixClean] = useState(false);
  const [fullfixDewarp, setFullfixDewarp] = useState(false);
  const [fullfixV2, setFullfixV2] = useState(false);

  // --- Replace mode state ---
  const [replaceFile, setReplaceFile] = useState<File | null>(null);
  const [replacePageCount, setReplacePageCount] = useState<number | null>(null);
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const [replaceIsValidating, setReplaceIsValidating] = useState(false);
  const [replacements, setReplacements] = useState<Map<number, File>>(new Map());
  const [replacePdf, setReplacePdf] = useState<PDFDocumentProxy | null>(null);

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

  const canStartFix =
    bookName.trim().length > 0 &&
    fixFile !== null &&
    !fixIsValidating &&
    (fullfixStraighten || fullfixClean || fullfixDewarp || fullfixV2) &&
    status === 'idle';

  const canStartReplace =
    replaceFile !== null &&
    replacements.size > 0 &&
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
      }
      if (newMode !== 'replace') {
        if (replacePdf) replacePdf.destroy();
        setReplacePdf(null);
        setReplaceFile(null);
        setReplacePageCount(null);
        setReplaceError(null);
        setReplaceIsValidating(false);
        setReplacements(new Map());
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

  // --- Replace mode: File change ---
  const handleReplaceFileChange = useCallback(
    (file: File | null) => {
      if (locked) return;

      // Clean up previous PDF
      if (replacePdf) replacePdf.destroy();
      setReplacePdf(null);
      setReplacements(new Map());

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
            setReplaceIsValidating(false);
            // Load PDFDocumentProxy for thumbnail rendering
            loadPdfDocument(file).then((pdf) => {
              setReplacePdf(pdf);
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

  // --- Clean up PDFs on unmount ---
  useEffect(() => {
    return () => {
      if (replacePdf) replacePdf.destroy();
    };
  }, [replacePdf]);

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
        result = mergeV2
          ? await runMergeV2Pipeline(slots, bookName, progressCb, cancelRef.current)
          : await runMergeOnlyPipeline(slots, bookName, progressCb, cancelRef.current);
      } else if (mode === 'replace') {
        const name = bookName.trim() || replaceFile!.name.replace(/\.pdf$/i, '');
        result = await runReplacePipeline(replaceFile!, replacements, name, progressCb, cancelRef.current);
      } else {
        result = await runFullfixPipeline(
          fixFile!, bookName,
          { straighten: fullfixStraighten, clean: fullfixClean, dewarp: fullfixDewarp, v2: fullfixV2 },
          progressCb, cancelRef.current
        );
      }

      // Clean up old URL if any
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);

      const url = URL.createObjectURL(result.blob);
      setDownloadUrl(url);
      setDownloadFilename(result.filename);
      setResultTotalPages(result.totalPages);
      setResultAngles(result.angles);
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
  }, [canStart, mode, slots, bookName, fixFile, replaceFile, replacements, downloadUrl, mergeV2, fullfixStraighten, fullfixClean, fullfixDewarp, fullfixV2]);

  // --- Cancel ---
  const handleCancel = useCallback(() => {
    cancelRef.current.cancelled = true;
  }, []);

  // --- Start over ---
  const handleStartOver = useCallback(() => {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
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
    if (replacePdf) replacePdf.destroy();
    setReplacePdf(null);
    setReplaceFile(null);
    setReplacePageCount(null);
    setReplaceError(null);
    setReplaceIsValidating(false);
    setReplacements(new Map());
  }, [downloadUrl, replacePdf]);

  // --- Derived values ---
  const totalPages = slots.reduce((sum, s) => sum + (s.pageCount ?? 0), 0);
  const filledCount = slots.filter((s) => s.file !== null).length;

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
      } else if (replacements.size === 0) {
        startHint = 'Click on a page thumbnail to replace it.';
      }
    } else {
      if (!fullfixStraighten && !fullfixClean && !fullfixDewarp && !fullfixV2) {
        startHint = 'Select at least one option above.';
      } else if (bookName.trim().length === 0 && fixFile === null) {
        startHint = 'Enter a book name and add a PDF to start.';
      } else if (bookName.trim().length === 0) {
        startHint = 'Enter a book name above to start.';
      } else if (fixFile === null) {
        startHint = 'Add a PDF file to start.';
      } else if (fixIsValidating) {
        startHint = 'Validating file...';
      }
    }
  }

  return (
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

      {/* Book name input (hidden in replace mode once PDF is loaded) */}
      {!(mode === 'replace' && replacePdf) && (
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

          {/* Merge options */}
          <div
            className="mt-5 mx-auto p-4 flex flex-col gap-3"
            style={{
              maxWidth: '32rem',
              background: 'var(--color-surface-card)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-lg)',
            }}
          >
            <p
              className="text-xs font-semibold uppercase tracking-wider"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              Options
            </p>
            <label
              className="flex items-center gap-3 cursor-pointer select-none"
              style={{ opacity: locked ? 0.5 : 1 }}
            >
              <input
                type="checkbox"
                checked={mergeV2}
                onChange={(e) => setMergeV2(e.target.checked)}
                disabled={locked}
                className="accent-[var(--color-primary)]"
                style={{ width: 18, height: 18 }}
              />
              <div className="flex flex-col">
                <span className="text-sm" style={{ color: 'var(--color-ink)' }}>
                  Straighten & Dewarp v2
                </span>
                <span className="text-xs" style={{ color: 'var(--color-ink-subtle)' }}>
                  Advanced: perspective correction, text-line dewarping, column alignment
                </span>
              </div>
            </label>
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
              locked={locked}
              onReplace={handleReplace}
              onUndoReplace={handleUndoReplace}
            />
          )}
        </section>
      ) : (
        <section className="mx-auto mb-8 sm:mb-10" style={{ maxWidth: '32rem' }}>
          <h2
            className="text-sm font-semibold uppercase tracking-wider mb-4"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            PDF file
          </h2>
          <FixDropZone
            file={fixFile}
            pageCount={fixPageCount}
            error={fixError}
            isValidating={fixIsValidating}
            locked={locked}
            onFileChange={handleFixFileChange}
          />

          {/* Fix options */}
          <div
            className="mt-5 p-4 flex flex-col gap-3"
            style={{
              background: 'var(--color-surface-card)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-lg)',
            }}
          >
            <p
              className="text-xs font-semibold uppercase tracking-wider"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              Options
            </p>
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
          </div>
        </section>
      )}

      {/* Start button (hidden during processing/done) */}
      {status === 'idle' && (
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
          <ProgressPanel
            phase={progressPhase}
            current={progress.current}
            total={progress.total}
            onCancel={handleCancel}
          />
        </section>
      )}

      {/* Result panel */}
      {status === 'done' && downloadUrl && (
        <section className="mb-8">
          <ResultPanel
            filename={downloadFilename}
            totalPages={resultTotalPages}
            downloadUrl={downloadUrl}
            angles={resultAngles}
            onStartOver={handleStartOver}
          />
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
    </main>
  );
}
