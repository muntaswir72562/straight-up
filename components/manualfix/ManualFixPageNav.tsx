'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { renderThumbnail } from '@/lib/pdf/thumbnail';

interface ManualFixPageNavProps {
  pdf: PDFDocumentProxy;
  totalPages: number;
  currentPage: number;
  editedPages: Set<number>;
  onPageSelect: (pageNumber: number) => void;
}

const THUMB_SIZE = 56;

function NavThumb({
  pdf,
  page,
  isCurrent,
  isEdited,
  onSelect,
}: {
  pdf: PDFDocumentProxy;
  page: number;
  isCurrent: boolean;
  isEdited: boolean;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const urlRef = useRef<string | null>(null);

  // Lazy visibility
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); obs.disconnect(); } },
      { rootMargin: '200px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Render thumbnail when visible
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    renderThumbnail(pdf, page, THUMB_SIZE).then((url) => {
      if (cancelled) return;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setSrc(url);
    });
    return () => { cancelled = true; };
  }, [visible, pdf, page]);

  // Cleanup
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  // Scroll into view when current
  useEffect(() => {
    if (isCurrent && ref.current) {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [isCurrent]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      className="flex-shrink-0 relative"
      style={{
        width: THUMB_SIZE,
        height: THUMB_SIZE * 1.4,
        borderRadius: 'var(--radius-sm)',
        border: isCurrent
          ? '2px solid var(--color-primary)'
          : '1.5px solid var(--color-border)',
        overflow: 'hidden',
        cursor: 'pointer',
        background: 'var(--color-surface-card)',
        outline: 'none',
        padding: 0,
      }}
    >
      {src && (
        <img
          src={src}
          alt={`Page ${page}`}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          draggable={false}
        />
      )}
      {/* Page number */}
      <span
        className="absolute text-[10px] font-medium"
        style={{
          bottom: 2,
          right: 3,
          color: 'var(--color-surface-card)',
          textShadow: '0 0 3px rgba(0,0,0,0.7)',
        }}
      >
        {page}
      </span>
      {/* Edited badge */}
      {isEdited && (
        <span
          className="absolute"
          style={{
            top: 3,
            right: 3,
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: 'var(--color-accent)',
          }}
        />
      )}
    </button>
  );
}

export function ManualFixPageNav({
  pdf,
  totalPages,
  currentPage,
  editedPages,
  onPageSelect,
}: ManualFixPageNavProps) {
  const handlePrev = useCallback(() => {
    if (currentPage > 1) onPageSelect(currentPage - 1);
  }, [currentPage, onPageSelect]);

  const handleNext = useCallback(() => {
    if (currentPage < totalPages) onPageSelect(currentPage + 1);
  }, [currentPage, totalPages, onPageSelect]);

  return (
    <div className="flex flex-col gap-2">
      {/* Page counter + prev/next */}
      <div className="flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={handlePrev}
          disabled={currentPage <= 1}
          className="text-sm px-2 py-1"
          style={{
            background: 'var(--color-surface-inset)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--color-ink)',
            cursor: currentPage <= 1 ? 'default' : 'pointer',
            opacity: currentPage <= 1 ? 0.4 : 1,
          }}
        >
          &#9664;
        </button>
        <span className="text-sm font-medium" style={{ color: 'var(--color-ink)' }}>
          Page {currentPage} of {totalPages}
        </span>
        <button
          type="button"
          onClick={handleNext}
          disabled={currentPage >= totalPages}
          className="text-sm px-2 py-1"
          style={{
            background: 'var(--color-surface-inset)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--color-ink)',
            cursor: currentPage >= totalPages ? 'default' : 'pointer',
            opacity: currentPage >= totalPages ? 0.4 : 1,
          }}
        >
          &#9654;
        </button>
      </div>

      {/* Thumbnail strip */}
      <div
        className="flex gap-2 overflow-x-auto py-1 px-1"
        style={{
          scrollbarWidth: 'thin',
        }}
      >
        {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
          <NavThumb
            key={page}
            pdf={pdf}
            page={page}
            isCurrent={page === currentPage}
            isEdited={editedPages.has(page)}
            onSelect={() => onPageSelect(page)}
          />
        ))}
      </div>
    </div>
  );
}
