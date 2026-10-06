'use client';

import { useRef, useState, useCallback } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PageThumbnail } from './PageThumbnail';
import { InsertedPageThumbnail } from './InsertedPageThumbnail';

export interface Insertion {
  afterPage: number;
  file: File;
  id: string;
}

interface PageGridProps {
  pdf: PDFDocumentProxy;
  totalPages: number;
  replacements: Map<number, File>;
  deletions: Set<number>;
  insertions: Insertion[];
  locked: boolean;
  onReplace: (pageNumber: number, file: File) => void;
  onUndoReplace: (pageNumber: number) => void;
  onDelete: (pageNumber: number) => void;
  onUndoDelete: (pageNumber: number) => void;
  onInsert: (afterPage: number, file: File) => void;
  onRemoveInsert: (id: string) => void;
}

function isAcceptedFile(file: File): boolean {
  return /^image\/(jpeg|png|webp)$/.test(file.type) ||
    /\.(jpe?g|png|webp)$/i.test(file.name) ||
    file.type === 'application/pdf' ||
    /\.pdf$/i.test(file.name);
}

function InsertHoverZone({
  afterPage,
  side,
  locked,
  onInsert,
}: {
  afterPage: number;
  side: 'left' | 'right';
  locked: boolean;
  onInsert: (afterPage: number, file: File) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [visible, setVisible] = useState(false);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (locked) return;
      fileInputRef.current?.click();
    },
    [locked]
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f && isAcceptedFile(f)) {
        onInsert(afterPage, f);
      }
      e.target.value = '';
    },
    [onInsert, afterPage]
  );

  if (locked) return null;

  return (
    <div
      style={{
        position: 'absolute',
        [side]: -8,
        top: 0,
        bottom: 0,
        width: 16,
        zIndex: 20,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onClick={handleClick}
      title={afterPage === 0 ? 'Insert before page 1' : `Insert after page ${afterPage}`}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp,application/pdf,.pdf"
        className="hidden"
        onChange={handleFileChange}
        tabIndex={-1}
      />
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: 'var(--color-primary)',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: visible ? 1 : 0,
          transform: visible ? 'scale(1)' : 'scale(0.7)',
          transition: 'opacity 150ms, transform 150ms',
          fontSize: '16px',
          fontWeight: 700,
          lineHeight: 1,
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        +
      </div>
    </div>
  );
}

export function PageGrid({
  pdf,
  totalPages,
  replacements,
  deletions,
  insertions,
  locked,
  onReplace,
  onUndoReplace,
  onDelete,
  onUndoDelete,
  onInsert,
  onRemoveInsert,
}: PageGridProps) {
  const replaceCount = replacements.size;
  const deleteCount = deletions.size;
  const insertCount = insertions.length;
  const outputPages = totalPages - deleteCount + insertCount;

  // Build flat list of grid items (no insert buttons — those are hover zones now)
  type GridItem =
    | { kind: 'inserted'; insertion: Insertion; key: string }
    | { kind: 'page'; pageNum: number; key: string };

  const items: GridItem[] = [];

  // Insertions before page 1 (afterPage=0)
  for (const ins of insertions.filter((i) => i.afterPage === 0)) {
    items.push({ kind: 'inserted', insertion: ins, key: `inserted-${ins.id}` });
  }

  for (let i = 1; i <= totalPages; i++) {
    items.push({ kind: 'page', pageNum: i, key: `page-${i}` });

    // Insertions after this page
    for (const ins of insertions.filter((ins) => ins.afterPage === i)) {
      items.push({ kind: 'inserted', insertion: ins, key: `inserted-${ins.id}` });
    }
  }

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
        <div className="flex items-center gap-3 flex-wrap justify-end">
          {replaceCount > 0 && (
            <span
              className="text-xs font-medium px-2.5 py-1"
              style={{
                background: 'oklch(55% 0.15 155 / 0.12)',
                color: 'var(--color-success)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {replaceCount} replaced
            </span>
          )}
          {deleteCount > 0 && (
            <span
              className="text-xs font-medium px-2.5 py-1"
              style={{
                background: 'oklch(55% 0.15 25 / 0.12)',
                color: 'var(--color-danger)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {deleteCount} deleted
            </span>
          )}
          {insertCount > 0 && (
            <span
              className="text-xs font-medium px-2.5 py-1"
              style={{
                background: 'oklch(55% 0.18 155 / 0.12)',
                color: 'oklch(45% 0.18 155)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {insertCount} inserted
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
            {outputPages} output {outputPages === 1 ? 'page' : 'pages'}
          </span>
        </div>
      </div>

      {/* Thumbnail grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
          gap: '16px',
        }}
      >
        {items.map((item, idx) => {
          if (item.kind === 'inserted') {
            // Determine afterPage for this insertion's right hover zone
            const afterPage = item.insertion.afterPage;
            return (
              <div key={item.key} style={{ position: 'relative' }}>
                <InsertedPageThumbnail
                  file={item.insertion.file}
                  id={item.insertion.id}
                  locked={locked}
                  onRemove={onRemoveInsert}
                />
                {/* Left hover zone on first item */}
                {idx === 0 && (
                  <InsertHoverZone afterPage={0} side="left" locked={locked} onInsert={onInsert} />
                )}
                <InsertHoverZone afterPage={afterPage} side="right" locked={locked} onInsert={onInsert} />
              </div>
            );
          }
          // kind === 'page'
          const pageNum = item.pageNum;
          return (
            <div key={item.key} style={{ position: 'relative' }}>
              <PageThumbnail
                pdf={pdf}
                pageNumber={pageNum}
                totalPages={totalPages}
                replacement={replacements.get(pageNum) ?? null}
                locked={locked}
                isDeleted={deletions.has(pageNum)}
                onReplace={onReplace}
                onUndoReplace={onUndoReplace}
                onDelete={onDelete}
                onUndoDelete={onUndoDelete}
              />
              {/* Left hover zone on first item (for inserting before page 1) */}
              {idx === 0 && (
                <InsertHoverZone afterPage={0} side="left" locked={locked} onInsert={onInsert} />
              )}
              {/* Right hover zone (for inserting after this page) */}
              <InsertHoverZone afterPage={pageNum} side="right" locked={locked} onInsert={onInsert} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
