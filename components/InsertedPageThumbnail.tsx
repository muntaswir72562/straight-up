'use client';

import { useState, useEffect, useCallback } from 'react';
import { renderFilePreview } from '@/lib/pdf/filePreview';

interface InsertedPageThumbnailProps {
  file: File;
  id: string;
  locked: boolean;
  onRemove: (id: string) => void;
}

export function InsertedPageThumbnail({
  file,
  id,
  locked,
  onRemove,
}: InsertedPageThumbnailProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    renderFilePreview(file).then((url) => {
      if (cancelled) {
        URL.revokeObjectURL(url);
      } else {
        setPreviewUrl(url);
      }
    }).catch(() => {
      if (!cancelled) setPreviewUrl(null);
    });

    return () => {
      cancelled = true;
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, [file]);

  const handleRemove = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (locked) return;
      onRemove(id);
    },
    [locked, onRemove, id]
  );

  return (
    <div
      className="relative select-none overflow-hidden"
      style={{
        aspectRatio: '0.707',
        background: 'var(--color-surface-inset)',
        border: '2px solid oklch(55% 0.18 155)',
        borderRadius: 'var(--radius-md)',
        opacity: locked ? 0.6 : 1,
        pointerEvents: locked ? 'none' : 'auto',
      }}
    >
      {/* Image preview */}
      {previewUrl && (
        <img
          src={previewUrl}
          alt="Inserted page"
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

      {/* Inserted badge — top right */}
      <span
        style={{
          position: 'absolute',
          top: 4,
          right: 4,
          padding: '1px 6px',
          fontSize: '0.6rem',
          fontWeight: 600,
          color: '#fff',
          background: 'oklch(55% 0.18 155)',
          borderRadius: 'var(--radius-sm)',
          lineHeight: 1.5,
        }}
      >
        Inserted
      </span>

      {/* Remove button — bottom right */}
      {!locked && (
        <button
          type="button"
          onClick={handleRemove}
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
          aria-label="Remove inserted page"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="2" y1="2" x2="10" y2="10" />
            <line x1="10" y1="2" x2="2" y2="10" />
          </svg>
        </button>
      )}
    </div>
  );
}
