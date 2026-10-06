'use client';

import { useState, useEffect, useCallback } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { renderThumbnail } from '@/lib/pdf/thumbnail';
import { renderFilePreview } from '@/lib/pdf/filePreview';

const PREVIEW_WIDTH = 800;

interface PageViewModalProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  totalPages: number;
  replacement: File | null;
  isDeleted: boolean;
  onClose: () => void;
  onNavigate: (pageNumber: number) => void;
  onOpenFullscreen: (pageNumber: number) => void;
}

export function PageViewModal({
  pdf,
  pageNumber,
  totalPages,
  replacement,
  isDeleted,
  onClose,
  onNavigate,
  onOpenFullscreen,
}: PageViewModalProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const isReplaced = replacement !== null;

  // Render the page or replacement preview
  useEffect(() => {
    let cancelled = false;

    const render = async () => {
      try {
        let url: string;
        if (replacement) {
          url = await renderFilePreview(replacement);
        } else {
          url = await renderThumbnail(pdf, pageNumber, PREVIEW_WIDTH);
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
        if (!cancelled) setImageUrl(null);
      }
    };

    setImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    render();

    return () => {
      cancelled = true;
    };
  }, [pdf, pageNumber, replacement]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      setImageUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, []);

  // Keyboard: Escape, ArrowLeft, ArrowRight
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowLeft' && pageNumber > 1) {
        onNavigate(pageNumber - 1);
      } else if (e.key === 'ArrowRight' && pageNumber < totalPages) {
        onNavigate(pageNumber + 1);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, onNavigate, pageNumber, totalPages]);

  // Body scroll lock
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const handlePrev = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (pageNumber > 1) onNavigate(pageNumber - 1);
    },
    [onNavigate, pageNumber]
  );

  const handleNext = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (pageNumber < totalPages) onNavigate(pageNumber + 1);
    },
    [onNavigate, pageNumber, totalPages]
  );

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'oklch(15% 0.02 270 / 0.6)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'modal-fade var(--duration-fast) var(--ease-out-expo)',
      }}
      onClick={onClose}
    >
      {/* Content */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          maxWidth: '90vw',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          animation: 'modal-scale var(--duration-normal) var(--ease-out-expo)',
        }}
      >
        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          className="focus-ring flex items-center justify-center"
          style={{
            position: 'absolute',
            top: -36,
            right: 0,
            width: 28,
            height: 28,
            background: 'oklch(15% 0.02 270 / 0.7)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            color: '#fff',
            cursor: 'pointer',
            zIndex: 10,
          }}
          aria-label="Close preview"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="2" y1="2" x2="12" y2="12" />
            <line x1="12" y1="2" x2="2" y2="12" />
          </svg>
        </button>

        {/* Page image */}
        <div
          style={{
            position: 'relative',
            background: 'var(--color-surface-card)',
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
            boxShadow: 'var(--shadow-lg)',
            maxHeight: '85vh',
          }}
        >
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={`Page ${pageNumber}`}
              style={{
                display: 'block',
                maxWidth: '85vw',
                maxHeight: '85vh',
                objectFit: 'contain',
              }}
              draggable={false}
            />
          ) : (
            <div
              className="slot-validating flex items-center justify-center"
              style={{
                width: 400,
                height: 566,
                background: 'var(--color-surface-inset)',
              }}
            />
          )}

          {/* Status badge */}
          {isReplaced && !isDeleted && (
            <span
              style={{
                position: 'absolute',
                top: 8,
                right: 8,
                padding: '2px 8px',
                fontSize: '0.7rem',
                fontWeight: 600,
                color: '#fff',
                background: 'var(--color-success)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              Replaced
            </span>
          )}
          {isDeleted && (
            <span
              style={{
                position: 'absolute',
                top: 8,
                right: 8,
                padding: '2px 8px',
                fontSize: '0.7rem',
                fontWeight: 600,
                color: '#fff',
                background: 'var(--color-danger)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              Deleted
            </span>
          )}
        </div>

        {/* Bottom bar: page info + fullscreen link */}
        <div
          className="flex items-center justify-between w-full mt-3 px-1"
          style={{ color: '#fff', maxWidth: '85vw' }}
        >
          <span className="text-sm font-medium" style={{ opacity: 0.8 }}>
            Page {pageNumber} of {totalPages}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenFullscreen(pageNumber);
            }}
            className="focus-ring flex items-center gap-1.5 text-xs font-medium px-2.5 py-1"
            style={{
              background: 'oklch(100% 0 0 / 0.15)',
              color: '#fff',
              borderRadius: 'var(--radius-sm)',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 4V1h3M8 1h3v3M11 8v3H8M4 11H1V8" />
            </svg>
            Fullscreen
          </button>
        </div>

        {/* Nav arrows */}
        {pageNumber > 1 && (
          <button
            type="button"
            onClick={handlePrev}
            className="focus-ring flex items-center justify-center"
            style={{
              position: 'absolute',
              left: -48,
              top: '50%',
              transform: 'translateY(-50%)',
              width: 36,
              height: 36,
              background: 'oklch(15% 0.02 270 / 0.7)',
              border: 'none',
              borderRadius: '50%',
              color: '#fff',
              cursor: 'pointer',
            }}
            aria-label="Previous page"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="10 2 4 8 10 14" />
            </svg>
          </button>
        )}
        {pageNumber < totalPages && (
          <button
            type="button"
            onClick={handleNext}
            className="focus-ring flex items-center justify-center"
            style={{
              position: 'absolute',
              right: -48,
              top: '50%',
              transform: 'translateY(-50%)',
              width: 36,
              height: 36,
              background: 'oklch(15% 0.02 270 / 0.7)',
              border: 'none',
              borderRadius: '50%',
              color: '#fff',
              cursor: 'pointer',
            }}
            aria-label="Next page"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 2 12 8 6 14" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
