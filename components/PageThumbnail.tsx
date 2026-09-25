'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { renderThumbnail } from '@/lib/pdf/thumbnail';
import { THUMBNAIL_WIDTH } from '@/lib/constants';

interface PageThumbnailProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  totalPages: number;
  replacement: File | null;
  locked: boolean;
  onReplace: (pageNumber: number, file: File) => void;
  onUndoReplace: (pageNumber: number) => void;
}

function isImageFile(file: File): boolean {
  return /^image\/(jpeg|png|webp)$/.test(file.type) ||
    /\.(jpe?g|png|webp)$/i.test(file.name);
}

export function PageThumbnail({
  pdf,
  pageNumber,
  totalPages,
  replacement,
  locked,
  onReplace,
  onUndoReplace,
}: PageThumbnailProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [replacementUrl, setReplacementUrl] = useState<string | null>(null);
  const isRenderingRef = useRef(false);
  const [hasBeenVisible, setHasBeenVisible] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  // Lazy rendering via IntersectionObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setHasBeenVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Render thumbnail when visible
  useEffect(() => {
    if (!hasBeenVisible || thumbnailUrl || isRenderingRef.current) return;

    let cancelled = false;
    isRenderingRef.current = true;

    renderThumbnail(pdf, pageNumber, THUMBNAIL_WIDTH)
      .then((url) => {
        if (cancelled) {
          if (url.startsWith('blob:')) URL.revokeObjectURL(url);
        } else {
          setThumbnailUrl(url);
        }
        isRenderingRef.current = false;
      })
      .catch(() => {
        isRenderingRef.current = false;
      });

    return () => {
      cancelled = true;
    };
  }, [hasBeenVisible, pdf, pageNumber, thumbnailUrl]);

  // Create/revoke replacement preview URL
  useEffect(() => {
    if (!replacement) {
      setReplacementUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }

    const url = URL.createObjectURL(replacement);
    setReplacementUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [replacement]);

  // Clean up thumbnail URL on unmount
  useEffect(() => {
    return () => {
      if (thumbnailUrl && thumbnailUrl.startsWith('blob:')) {
        URL.revokeObjectURL(thumbnailUrl);
      }
    };
  }, [thumbnailUrl]);

  const handleClick = useCallback(() => {
    if (locked) return;
    fileInputRef.current?.click();
  }, [locked]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (locked) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInputRef.current?.click();
      }
    },
    [locked]
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f && isImageFile(f)) {
        onReplace(pageNumber, f);
      }
      e.target.value = '';
    },
    [onReplace, pageNumber]
  );

  const handleUndo = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (locked) return;
      onUndoReplace(pageNumber);
    },
    [locked, onUndoReplace, pageNumber]
  );

  // Drag and drop
  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (locked) return;
      dragCounterRef.current++;
      if (dragCounterRef.current === 1) setIsDragOver(true);
    },
    [locked]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragOver(false);
      if (locked) return;

      const files = Array.from(e.dataTransfer.files);
      const img = files.find(isImageFile);
      if (img) onReplace(pageNumber, img);
    },
    [locked, onReplace, pageNumber]
  );

  const isReplaced = replacement !== null;
  const displayUrl = isReplaced ? replacementUrl : thumbnailUrl;
  const isLoading = !displayUrl && (hasBeenVisible || isReplaced);

  return (
    <div
      ref={containerRef}
      role="button"
      tabIndex={locked ? -1 : 0}
      aria-label={
        isReplaced
          ? `Page ${pageNumber} of ${totalPages} (replaced). Click to change or press undo.`
          : `Page ${pageNumber} of ${totalPages}. Click to replace.`
      }
      className="focus-ring relative cursor-pointer select-none overflow-hidden"
      style={{
        aspectRatio: '0.707',
        background: isDragOver ? 'var(--color-drop-hover)' : 'var(--color-surface-inset)',
        border: isDragOver
          ? '2px solid var(--color-primary)'
          : isReplaced
            ? '2px solid var(--color-success)'
            : '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        opacity: locked ? 0.6 : 1,
        pointerEvents: locked ? 'none' : 'auto',
        transition: `border-color var(--duration-fast) var(--ease-out-expo), background var(--duration-fast) var(--ease-out-expo)`,
      }}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        className="hidden"
        onChange={handleFileChange}
        tabIndex={-1}
      />

      {/* Thumbnail image */}
      {displayUrl && (
        <img
          src={displayUrl}
          alt={`Page ${pageNumber}`}
          className="thumbnail-fade-in"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
          draggable={false}
        />
      )}

      {/* Loading skeleton */}
      {isLoading && (
        <div
          className="slot-validating"
          style={{
            position: 'absolute',
            inset: 0,
            background: 'var(--color-surface-inset)',
          }}
        />
      )}

      {/* Page number badge — top left */}
      <span
        style={{
          position: 'absolute',
          top: 4,
          left: 4,
          padding: '1px 6px',
          fontSize: '0.65rem',
          fontWeight: 600,
          color: '#fff',
          background: 'oklch(15% 0.02 270 / 0.7)',
          borderRadius: 'var(--radius-sm)',
          lineHeight: 1.5,
        }}
      >
        {pageNumber} / {totalPages}
      </span>

      {/* Replaced badge — top right */}
      {isReplaced && (
        <span
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            padding: '1px 6px',
            fontSize: '0.6rem',
            fontWeight: 600,
            color: '#fff',
            background: 'var(--color-success)',
            borderRadius: 'var(--radius-sm)',
            lineHeight: 1.5,
          }}
        >
          Replaced
        </span>
      )}

      {/* Undo button — bottom right (only when replaced) */}
      {isReplaced && !locked && (
        <button
          type="button"
          onClick={handleUndo}
          className="focus-ring flex items-center justify-center"
          style={{
            position: 'absolute',
            bottom: 4,
            right: 4,
            width: 22,
            height: 22,
            background: 'oklch(15% 0.02 270 / 0.7)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            color: '#fff',
            cursor: 'pointer',
            padding: 0,
          }}
          aria-label={`Undo replacement for page ${pageNumber}`}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="2" y1="2" x2="10" y2="10" />
            <line x1="10" y1="2" x2="2" y2="10" />
          </svg>
        </button>
      )}

      {/* Hover overlay when not replaced */}
      {!isReplaced && displayUrl && !isDragOver && (
        <div
          className="flex items-center justify-center"
          style={{
            position: 'absolute',
            inset: 0,
            background: 'oklch(15% 0.02 270 / 0)',
            transition: 'background var(--duration-fast) var(--ease-out-expo)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'oklch(15% 0.02 270 / 0.3)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'oklch(15% 0.02 270 / 0)';
          }}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ opacity: 0, transition: 'opacity var(--duration-fast) var(--ease-out-expo)' }}
            className="thumbnail-replace-icon"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </div>
      )}
    </div>
  );
}
