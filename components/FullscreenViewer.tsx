'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { renderThumbnail } from '@/lib/pdf/thumbnail';
import { renderFilePreview } from '@/lib/pdf/filePreview';
import { renderPage } from '@/lib/pdf/render';
import { THUMBNAIL_WIDTH, FULLSCREEN_RENDER_WIDTH, RENDER_DPI } from '@/lib/constants';
import { LassoCanvas } from './LassoCanvas';
import type { Insertion } from './PageGrid';

function isAcceptedFile(file: File): boolean {
  return /^image\/(jpeg|png|webp)$/.test(file.type) ||
    /\.(jpe?g|png|webp)$/i.test(file.name) ||
    file.type === 'application/pdf' ||
    /\.pdf$/i.test(file.name);
}

// ── Sidebar Thumbnail ──────────────────────────────────────────────

function SidebarThumb({
  pdf,
  pageNumber,
  isActive,
  isReplaced,
  isDeleted,
  onClick,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  isActive: boolean;
  isReplaced: boolean;
  isDeleted: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } },
      { rootMargin: '100px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || url) return;
    let cancelled = false;
    renderThumbnail(pdf, pageNumber, 60).then((u) => {
      if (cancelled) URL.revokeObjectURL(u);
      else setUrl(u);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [visible, pdf, pageNumber, url]);

  useEffect(() => {
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [url]);

  // Scroll active thumb into view in sidebar
  useEffect(() => {
    if (isActive && ref.current) {
      ref.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [isActive]);

  return (
    <div
      ref={ref}
      onClick={onClick}
      style={{
        width: 52,
        aspectRatio: '0.707',
        borderRadius: 'var(--radius-sm)',
        overflow: 'hidden',
        cursor: 'pointer',
        border: isActive ? '2px solid var(--color-primary)' : '1px solid var(--color-border)',
        opacity: isDeleted ? 0.35 : 1,
        position: 'relative',
        flexShrink: 0,
        background: 'var(--color-surface-inset)',
      }}
    >
      {url && (
        <img src={url} alt={`Page ${pageNumber}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} draggable={false} />
      )}
      <span style={{
        position: 'absolute', bottom: 1, left: 0, right: 0, textAlign: 'center',
        fontSize: '0.55rem', fontWeight: 600, color: '#fff',
        background: 'oklch(15% 0.02 270 / 0.6)', lineHeight: 1.4,
      }}>
        {pageNumber}
      </span>
      {isReplaced && (
        <span style={{
          position: 'absolute', top: 1, right: 1, width: 6, height: 6,
          borderRadius: '50%', background: 'var(--color-success)',
        }} />
      )}
    </div>
  );
}

// ── Main Page View ─────────────────────────────────────────────────

function FullscreenPage({
  pdf,
  pageNumber,
  totalPages,
  replacement,
  isDeleted,
  isReplaced,
  locked,
  onReplace,
  onUndoReplace,
  onDelete,
  onUndoDelete,
  onInsert,
  onStartInpaint,
  onObserve,
  renderWidth,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  totalPages: number;
  replacement: File | null;
  isDeleted: boolean;
  isReplaced: boolean;
  locked: boolean;
  onReplace: (pageNumber: number, file: File) => void;
  onUndoReplace: (pageNumber: number) => void;
  onDelete: (pageNumber: number) => void;
  onUndoDelete: (pageNumber: number) => void;
  onInsert: (afterPage: number, file: File) => void;
  onStartInpaint: (pageNumber: number) => void;
  onObserve: (pageNumber: number, ratio: number) => void;
  renderWidth: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const insertFileRef = useRef<HTMLInputElement>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [hasBeenVisible, setHasBeenVisible] = useState(false);

  // Lazy rendering
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setHasBeenVisible(true); obs.disconnect(); } },
      { rootMargin: '400px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Current page tracking
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => { onObserve(pageNumber, e.intersectionRatio); },
      { threshold: [0, 0.25, 0.5, 0.75, 1] }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [pageNumber, onObserve]);

  // Render image
  useEffect(() => {
    if (!hasBeenVisible) return;
    let cancelled = false;

    const render = async () => {
      try {
        let url: string;
        if (replacement) {
          url = await renderFilePreview(replacement);
        } else {
          url = await renderThumbnail(pdf, pageNumber, FULLSCREEN_RENDER_WIDTH);
        }
        if (cancelled) {
          URL.revokeObjectURL(url);
        } else {
          setImageUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return url;
          });
        }
      } catch {
        /* ignore */
      }
    };

    setImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    render();
    return () => { cancelled = true; };
  }, [hasBeenVisible, pdf, pageNumber, replacement]);

  useEffect(() => {
    return () => {
      setImageUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, []);

  return (
    <div
      ref={containerRef}
      id={`fullscreen-page-${pageNumber}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '24px 0',
        opacity: isDeleted ? 0.35 : 1,
        transition: 'opacity var(--duration-fast)',
      }}
    >
      {/* Page image */}
      <div style={{
        position: 'relative',
        background: 'var(--color-surface-card)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        boxShadow: 'var(--shadow-md)',
        border: isReplaced ? '2px solid var(--color-success)' : isDeleted ? '2px solid var(--color-danger)' : '1px solid var(--color-border)',
        maxWidth: renderWidth,
        width: '100%',
      }}>
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={`Page ${pageNumber}`}
            style={{ display: 'block', width: '100%', height: 'auto' }}
            draggable={false}
          />
        ) : (
          <div
            className="slot-validating"
            style={{ width: '100%', aspectRatio: '0.707', background: 'var(--color-surface-inset)' }}
          />
        )}

        {/* Page number badge */}
        <span style={{
          position: 'absolute', top: 8, left: 8,
          padding: '2px 8px', fontSize: '0.7rem', fontWeight: 600,
          color: '#fff', background: 'oklch(15% 0.02 270 / 0.7)',
          borderRadius: 'var(--radius-sm)',
        }}>
          {pageNumber} / {totalPages}
        </span>

        {/* Status badge */}
        {isReplaced && !isDeleted && (
          <span style={{
            position: 'absolute', top: 8, right: 8,
            padding: '2px 8px', fontSize: '0.7rem', fontWeight: 600,
            color: '#fff', background: 'var(--color-success)',
            borderRadius: 'var(--radius-sm)',
          }}>
            Replaced
          </span>
        )}
        {isDeleted && (
          <span style={{
            position: 'absolute', top: 8, right: 8,
            padding: '2px 8px', fontSize: '0.7rem', fontWeight: 600,
            color: '#fff', background: 'var(--color-danger)',
            borderRadius: 'var(--radius-sm)',
          }}>
            Deleted
          </span>
        )}
      </div>

      {/* Action buttons */}
      {!locked && (
        <div className="flex items-center gap-2 mt-3 flex-wrap justify-center">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp,application/pdf,.pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f && isAcceptedFile(f)) onReplace(pageNumber, f);
              e.target.value = '';
            }}
            tabIndex={-1}
          />
          <input
            ref={insertFileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp,application/pdf,.pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f && isAcceptedFile(f)) onInsert(pageNumber, f);
              e.target.value = '';
            }}
            tabIndex={-1}
          />

          {!isDeleted && (
            <>
              <ActionBtn
                label="Replace"
                icon={<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1 4h10M8 1l3 3-3 3" /><path d="M11 8H1M4 11l-3-3 3-3" /></svg>}
                onClick={() => fileInputRef.current?.click()}
              />
              <ActionBtn
                label="Delete"
                icon={<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1.5 3h9M4.5 3V1.5h3V3M3 3v7.5h6V3" /></svg>}
                onClick={() => onDelete(pageNumber)}
                danger
              />
              <ActionBtn
                label="Insert After"
                icon={<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><line x1="6" y1="2" x2="6" y2="10" /><line x1="2" y1="6" x2="10" y2="6" /></svg>}
                onClick={() => insertFileRef.current?.click()}
              />
              <ActionBtn
                label="Remove Artifact"
                icon={<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.5 5.5a5 5 0 0 1-9 3M1.5 6.5a5 5 0 0 1 9-3" /><circle cx="6" cy="6" r="1.5" /></svg>}
                onClick={() => onStartInpaint(pageNumber)}
              />
            </>
          )}
          {isReplaced && !isDeleted && (
            <ActionBtn
              label="Undo Replace"
              icon={<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 5.5C2 5.5 3 2 6.5 2C9 2 10.5 4 10.5 6C10.5 8 9 10 6.5 10H4" /><polyline points="4 3.5 2 5.5 4 7.5" /></svg>}
              onClick={() => onUndoReplace(pageNumber)}
            />
          )}
          {isDeleted && (
            <ActionBtn
              label="Undo Delete"
              icon={<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 5.5C2 5.5 3 2 6.5 2C9 2 10.5 4 10.5 6C10.5 8 9 10 6.5 10H4" /><polyline points="4 3.5 2 5.5 4 7.5" /></svg>}
              onClick={() => onUndoDelete(pageNumber)}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── Inserted Page in Fullscreen ────────────────────────────────────

function FullscreenInserted({
  insertion,
  locked,
  onRemove,
  renderWidth,
}: {
  insertion: Insertion;
  locked: boolean;
  onRemove: (id: string) => void;
  renderWidth: number;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    renderFilePreview(insertion.file).then((u) => {
      if (cancelled) URL.revokeObjectURL(u);
      else setUrl(u);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [insertion.file]);

  useEffect(() => {
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [url]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '24px 0',
    }}>
      <div style={{
        position: 'relative',
        background: 'var(--color-surface-card)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        boxShadow: 'var(--shadow-md)',
        border: '2px solid oklch(55% 0.18 155)',
        maxWidth: renderWidth,
        width: '100%',
      }}>
        {url ? (
          <img src={url} alt="Inserted page" style={{ display: 'block', width: '100%', height: 'auto' }} draggable={false} />
        ) : (
          <div className="slot-validating" style={{ width: '100%', aspectRatio: '0.707', background: 'var(--color-surface-inset)' }} />
        )}
        <span style={{
          position: 'absolute', top: 8, right: 8,
          padding: '2px 8px', fontSize: '0.7rem', fontWeight: 600,
          color: '#fff', background: 'oklch(55% 0.18 155)',
          borderRadius: 'var(--radius-sm)',
        }}>
          Inserted
        </span>
      </div>
      {!locked && (
        <div className="flex items-center gap-2 mt-3">
          <ActionBtn
            label="Remove"
            icon={<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="2" y1="2" x2="10" y2="10" /><line x1="10" y1="2" x2="2" y2="10" /></svg>}
            onClick={() => onRemove(insertion.id)}
            danger
          />
        </div>
      )}
    </div>
  );
}

// ── Action Button ──────────────────────────────────────────────────

function ActionBtn({
  label,
  icon,
  onClick,
  danger,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5"
      style={{
        background: danger ? 'var(--color-danger-subtle)' : 'var(--color-surface-inset)',
        color: danger ? 'var(--color-danger)' : 'var(--color-ink-muted)',
        borderRadius: 'var(--radius-sm)',
        border: `1px solid ${danger ? 'oklch(55% 0.22 25 / 0.2)' : 'var(--color-border)'}`,
        cursor: 'pointer',
        transition: 'background var(--duration-fast)',
      }}
      aria-label={label}
    >
      {icon}
      {label}
    </button>
  );
}

// ── FullscreenViewer ───────────────────────────────────────────────

interface FullscreenViewerProps {
  pdf: PDFDocumentProxy;
  totalPages: number;
  replacements: Map<number, File>;
  deletions: Set<number>;
  insertions: Insertion[];
  locked: boolean;
  initialPage?: number;
  onClose: () => void;
  onReplace: (pageNumber: number, file: File) => void;
  onUndoReplace: (pageNumber: number) => void;
  onDelete: (pageNumber: number) => void;
  onUndoDelete: (pageNumber: number) => void;
  onInsert: (afterPage: number, file: File) => void;
  onRemoveInsert: (id: string) => void;
}

export function FullscreenViewer({
  pdf,
  totalPages,
  replacements,
  deletions,
  insertions,
  locked,
  initialPage = 1,
  onClose,
  onReplace,
  onUndoReplace,
  onDelete,
  onUndoDelete,
  onInsert,
  onRemoveInsert,
}: FullscreenViewerProps) {
  const mainRef = useRef<HTMLDivElement>(null);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [pageInput, setPageInput] = useState(String(initialPage));
  const visibilityRef = useRef<Map<number, number>>(new Map());
  const [zoom, setZoom] = useState(1.0);
  const pageWidth = Math.round(FULLSCREEN_RENDER_WIDTH * zoom);

  // Inpaint state
  const [inpaintPage, setInpaintPage] = useState<number | null>(null);
  const [inpaintImageUrl, setInpaintImageUrl] = useState<string | null>(null);
  const [inpaintDims, setInpaintDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [inpaintProcessing, setInpaintProcessing] = useState(false);
  const [inpaintError, setInpaintError] = useState<string | null>(null);

  // Body scroll lock
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Scroll to initial page on mount
  useEffect(() => {
    const el = document.getElementById(`fullscreen-page-${initialPage}`);
    if (el) el.scrollIntoView({ block: 'start' });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard: Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (inpaintPage !== null) {
          handleCancelInpaint();
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, inpaintPage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track which page is most visible
  const handleObserve = useCallback((pageNumber: number, ratio: number) => {
    visibilityRef.current.set(pageNumber, ratio);

    // Find the most visible page
    let bestPage = currentPage;
    let bestRatio = 0;
    visibilityRef.current.forEach((r, p) => {
      if (r > bestRatio) {
        bestRatio = r;
        bestPage = p;
      }
    });
    if (bestPage !== currentPage && bestRatio > 0.1) {
      setCurrentPage(bestPage);
      setPageInput(String(bestPage));
    }
  }, [currentPage]);

  const jumpToPage = useCallback((page: number) => {
    const clamped = Math.max(1, Math.min(page, totalPages));
    const el = document.getElementById(`fullscreen-page-${clamped}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setCurrentPage(clamped);
    setPageInput(String(clamped));
  }, [totalPages]);

  const handlePageInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const val = parseInt(pageInput, 10);
      if (!isNaN(val)) jumpToPage(val);
    }
  }, [pageInput, jumpToPage]);

  // ── Inpaint handlers ─────────────────────────────────────────────

  const handleStartInpaint = useCallback(async (pageNumber: number) => {
    setInpaintError(null);
    setInpaintProcessing(false);

    const replacement = replacements.get(pageNumber);

    if (replacement) {
      // Render from replacement file
      const url = URL.createObjectURL(replacement);
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to load replacement'));
        img.src = url;
      });
      setInpaintDims({ w: img.naturalWidth, h: img.naturalHeight });
      setInpaintImageUrl(url);
    } else {
      // Render from PDF at full DPI
      const result = await renderPage(pdf, pageNumber, RENDER_DPI);
      const canvas = new OffscreenCanvas(result.width, result.height);
      const ctx = canvas.getContext('2d')!;
      const imgData = ctx.createImageData(result.width, result.height);
      imgData.data.set(result.imageData);
      ctx.putImageData(imgData, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
      const url = URL.createObjectURL(blob);
      setInpaintDims({ w: result.width, h: result.height });
      setInpaintImageUrl(url);
    }

    setInpaintPage(pageNumber);
  }, [pdf, replacements]);

  const handleCancelInpaint = useCallback(() => {
    if (inpaintImageUrl) URL.revokeObjectURL(inpaintImageUrl);
    setInpaintPage(null);
    setInpaintImageUrl(null);
    setInpaintError(null);
    setInpaintProcessing(false);
  }, [inpaintImageUrl]);

  const handleInpaintComplete = useCallback(async (mask: Blob, image: Blob) => {
    if (inpaintPage === null) return;
    setInpaintProcessing(true);
    setInpaintError(null);

    const formData = new FormData();
    formData.append('image', image, 'page.jpg');
    formData.append('mask', mask, 'mask.png');

    try {
      const response = await fetch('/api/inpaint', { method: 'POST', body: formData });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: 'Inpaint failed' }));
        throw new Error(errData.error || 'Inpaint failed');
      }

      const resultBlob = await response.blob();
      const resultFile = new File([resultBlob], `inpainted-page-${inpaintPage}.jpg`, { type: 'image/jpeg' });
      onReplace(inpaintPage, resultFile);
      handleCancelInpaint();
    } catch (err) {
      setInpaintError(err instanceof Error ? err.message : 'Inpaint failed');
      setInpaintProcessing(false);
    }
  }, [inpaintPage, onReplace, handleCancelInpaint]);

  // Build flat list (same as PageGrid)
  type ViewItem =
    | { kind: 'page'; pageNum: number }
    | { kind: 'inserted'; insertion: Insertion };

  const items: ViewItem[] = [];
  for (const ins of insertions.filter((i) => i.afterPage === 0)) {
    items.push({ kind: 'inserted', insertion: ins });
  }
  for (let i = 1; i <= totalPages; i++) {
    items.push({ kind: 'page', pageNum: i });
    for (const ins of insertions.filter((ins) => ins.afterPage === i)) {
      items.push({ kind: 'inserted', insertion: ins });
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'var(--color-surface-page)',
      display: 'flex', flexDirection: 'column',
      animation: 'modal-fade var(--duration-fast) var(--ease-out-expo)',
    }}>
      {/* Toolbar */}
      <div style={{
        height: 48, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 16px',
        borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-surface-card)',
      }}>
        <button
          type="button"
          onClick={onClose}
          className="focus-ring flex items-center justify-center"
          style={{
            width: 32, height: 32,
            background: 'none', border: 'none',
            color: 'var(--color-ink-muted)', cursor: 'pointer',
            borderRadius: 'var(--radius-sm)',
          }}
          aria-label="Close fullscreen viewer"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="3" x2="15" y2="15" />
            <line x1="15" y1="3" x2="3" y2="15" />
          </svg>
        </button>

        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>Page</span>
          <input
            type="text"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onKeyDown={handlePageInputKeyDown}
            onBlur={() => {
              const val = parseInt(pageInput, 10);
              if (!isNaN(val)) jumpToPage(val);
              else setPageInput(String(currentPage));
            }}
            className="focus-ring text-center text-sm font-medium"
            style={{
              width: 48, padding: '2px 4px',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-surface-inset)',
              color: 'var(--color-ink)',
            }}
          />
          <span className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>/ {totalPages}</span>
        </div>

        {/* Zoom controls */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.3, z - 0.15))}
            className="focus-ring flex items-center justify-center"
            style={{
              width: 28, height: 28,
              background: 'none', border: '1px solid var(--color-border)',
              color: 'var(--color-ink-muted)', cursor: 'pointer',
              borderRadius: 'var(--radius-sm)', fontSize: '16px', fontWeight: 700,
            }}
            aria-label="Zoom out"
          >
            −
          </button>
          <span
            className="text-xs font-medium text-center"
            style={{ width: 40, color: 'var(--color-ink-muted)' }}
          >
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(3.0, z + 0.15))}
            className="focus-ring flex items-center justify-center"
            style={{
              width: 28, height: 28,
              background: 'none', border: '1px solid var(--color-border)',
              color: 'var(--color-ink-muted)', cursor: 'pointer',
              borderRadius: 'var(--radius-sm)', fontSize: '16px', fontWeight: 700,
            }}
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
      </div>

      {/* Body */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Sidebar */}
        <div style={{
          width: 72, flexShrink: 0,
          borderRight: '1px solid var(--color-border)',
          overflowY: 'auto',
          padding: '8px 8px',
          display: 'flex', flexDirection: 'column', gap: 6,
          background: 'var(--color-surface-card)',
        }}>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((pn) => (
            <SidebarThumb
              key={pn}
              pdf={pdf}
              pageNumber={pn}
              isActive={pn === currentPage}
              isReplaced={replacements.has(pn)}
              isDeleted={deletions.has(pn)}
              onClick={() => jumpToPage(pn)}
            />
          ))}
        </div>

        {/* Main scrollable area */}
        <div
          ref={mainRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '0 24px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}
        >
          {items.map((item) => {
            if (item.kind === 'inserted') {
              return (
                <FullscreenInserted
                  key={`ins-${item.insertion.id}`}
                  insertion={item.insertion}
                  locked={locked}
                  onRemove={onRemoveInsert}
                  renderWidth={pageWidth}
                />
              );
            }
            const pn = item.pageNum;
            return (
              <FullscreenPage
                key={`page-${pn}`}
                pdf={pdf}
                pageNumber={pn}
                totalPages={totalPages}
                replacement={replacements.get(pn) ?? null}
                isDeleted={deletions.has(pn)}
                isReplaced={replacements.has(pn)}
                locked={locked}
                onReplace={onReplace}
                onUndoReplace={onUndoReplace}
                onDelete={onDelete}
                onUndoDelete={onUndoDelete}
                onInsert={onInsert}
                onStartInpaint={handleStartInpaint}
                onObserve={handleObserve}
                renderWidth={pageWidth}
              />
            );
          })}
        </div>
      </div>

      {/* Inpaint overlay */}
      {inpaintPage !== null && inpaintImageUrl && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 300,
          background: 'oklch(15% 0.02 270 / 0.85)',
          display: 'flex', flexDirection: 'column',
          animation: 'modal-fade var(--duration-fast) var(--ease-out-expo)',
        }}>
          {/* Inpaint toolbar */}
          <div style={{
            height: 48, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '0 16px',
            borderBottom: '1px solid oklch(100% 0 0 / 0.1)',
          }}>
            <span className="text-sm font-medium" style={{ color: '#fff' }}>
              Draw around the artifact to remove it — Page {inpaintPage}
            </span>
            <div className="flex items-center gap-2">
              {inpaintError && (
                <span className="text-xs" style={{ color: 'oklch(70% 0.2 25)' }}>{inpaintError}</span>
              )}
              {inpaintProcessing && (
                <span className="text-xs" style={{ color: 'oklch(80% 0 0)' }}>Processing...</span>
              )}
            </div>
          </div>

          <div style={{ flex: 1, overflow: 'hidden' }}>
            <LassoCanvas
              imageUrl={inpaintImageUrl}
              imageWidth={inpaintDims.w}
              imageHeight={inpaintDims.h}
              processing={inpaintProcessing}
              onComplete={handleInpaintComplete}
              onCancel={handleCancelInpaint}
            />
          </div>
        </div>
      )}
    </div>
  );
}
