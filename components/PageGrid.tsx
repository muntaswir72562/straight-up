'use client';

import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PageThumbnail } from './PageThumbnail';

interface PageGridProps {
  pdf: PDFDocumentProxy;
  totalPages: number;
  replacements: Map<number, File>;
  locked: boolean;
  onReplace: (pageNumber: number, file: File) => void;
  onUndoReplace: (pageNumber: number) => void;
}

export function PageGrid({
  pdf,
  totalPages,
  replacements,
  locked,
  onReplace,
  onUndoReplace,
}: PageGridProps) {
  const replaceCount = replacements.size;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2
          className="text-sm font-semibold uppercase tracking-wider"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          Pages
        </h2>
        <div className="flex items-center gap-3">
          {replaceCount > 0 && (
            <span
              className="text-xs font-medium px-2.5 py-1"
              style={{
                background: 'oklch(55% 0.15 155 / 0.12)',
                color: 'var(--color-success)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {replaceCount} {replaceCount === 1 ? 'page' : 'pages'} replaced
            </span>
          )}
          <span
            className="text-xs font-medium px-2.5 py-1"
            style={{
              background: 'var(--color-primary-subtle)',
              color: 'var(--color-primary)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            {totalPages} {totalPages === 1 ? 'page' : 'pages'}
          </span>
        </div>
      </div>

      {/* Thumbnail grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
          gap: '12px',
        }}
      >
        {Array.from({ length: totalPages }, (_, i) => {
          const pageNum = i + 1;
          return (
            <PageThumbnail
              key={pageNum}
              pdf={pdf}
              pageNumber={pageNum}
              totalPages={totalPages}
              replacement={replacements.get(pageNum) ?? null}
              locked={locked}
              onReplace={onReplace}
              onUndoReplace={onUndoReplace}
            />
          );
        })}
      </div>
    </div>
  );
}
