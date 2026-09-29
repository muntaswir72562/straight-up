'use client';

import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { renderThumbnail } from '@/lib/pdf/thumbnail';
import { MANUALFIX_PREVIEW_WIDTH } from '@/lib/constants';
import type { ManualFixLevels } from '@/lib/types';

interface ManualFixPreviewProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  levels: ManualFixLevels;
  rotation: number;
  perspectiveX: number;
  perspectiveY: number;
}

function buildPreviewStyle(
  levels: ManualFixLevels,
  rotation: number,
  perspectiveX: number,
  perspectiveY: number,
): React.CSSProperties {
  // Levels -> CSS filter approximation
  const range = Math.max(levels.whitePoint - levels.blackPoint, 1);
  const contrast = 255 / range;
  // Shift brightness so that blackPoint maps to 0
  const brightnessShift = (-levels.blackPoint / 255) * contrast + (contrast - 1) * 0.5;

  const filters: string[] = [];
  if (contrast !== 1 || brightnessShift !== 0) {
    filters.push(`contrast(${contrast.toFixed(3)})`);
    filters.push(`brightness(${(1 + brightnessShift).toFixed(3)})`);
  }

  // Transform
  const transforms: string[] = [];
  if (perspectiveX !== 0 || perspectiveY !== 0) {
    transforms.push('perspective(800px)');
    if (perspectiveX !== 0) transforms.push(`rotateX(${perspectiveX}deg)`);
    if (perspectiveY !== 0) transforms.push(`rotateY(${perspectiveY}deg)`);
  }
  if (rotation !== 0) {
    transforms.push(`rotate(${rotation}deg)`);
  }

  return {
    filter: filters.length > 0 ? filters.join(' ') : undefined,
    transform: transforms.length > 0 ? transforms.join(' ') : undefined,
    transformOrigin: 'center center',
    transition: 'filter 50ms linear, transform 50ms linear',
  };
}

export function ManualFixPreview({
  pdf,
  pageNumber,
  levels,
  rotation,
  perspectiveX,
  perspectiveY,
}: ManualFixPreviewProps) {
  const [src, setSrc] = useState<string | null>(null);
  const prevUrl = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    renderThumbnail(pdf, pageNumber, MANUALFIX_PREVIEW_WIDTH).then((url) => {
      if (cancelled) return;
      if (prevUrl.current) URL.revokeObjectURL(prevUrl.current);
      prevUrl.current = url;
      setSrc(url);
    });

    return () => {
      cancelled = true;
    };
  }, [pdf, pageNumber]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (prevUrl.current) URL.revokeObjectURL(prevUrl.current);
    };
  }, []);

  const previewStyle = buildPreviewStyle(levels, rotation, perspectiveX, perspectiveY);

  return (
    <div
      className="flex items-center justify-center"
      style={{
        background: 'var(--color-surface-inset)',
        borderRadius: 'var(--radius-lg)',
        border: '1.5px solid var(--color-border)',
        overflow: 'hidden',
        minHeight: 300,
        padding: 24,
      }}
    >
      {src ? (
        <img
          src={src}
          alt={`Page ${pageNumber} preview`}
          style={{
            maxWidth: '100%',
            maxHeight: '60vh',
            borderRadius: 'var(--radius-sm)',
            boxShadow: 'var(--shadow-md)',
            ...previewStyle,
          }}
          draggable={false}
        />
      ) : (
        <div
          className="animate-pulse"
          style={{
            width: 200,
            height: 280,
            background: 'var(--color-border)',
            borderRadius: 'var(--radius-sm)',
          }}
        />
      )}
    </div>
  );
}
