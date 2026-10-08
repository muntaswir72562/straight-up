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
  pageOrder: number[];
  selectedPages: Set<number>;
  onPageClick: (pageNumber: number) => void;
  onReplace: (pageNumber: number, file: File) => void;
  onUndoReplace: (pageNumber: number) => void;
  onDelete: (pageNumber: number) => void;
  onUndoDelete: (pageNumber: number) => void;
  onInsert: (afterPage: number, file: File) => void;
  onRemoveInsert: (id: string) => void;
  onOpenFullscreen: () => void;
  onToggleSelect: (pageNumber: number) => void;
  onMoveTo: (afterPage: number) => void;
  onClearSelection: () => void;
  onResetOrder: () => void;
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
  pageOrder,
  selectedPages,
  onPageClick,
  onReplace,
  onUndoReplace,
  onDelete,
  onUndoDelete,
  onInsert,
  onRemoveInsert,
  onOpenFullscreen,
  onToggleSelect,
  onMoveTo,
  onClearSelection,
  onResetOrder,
}: PageGridProps) {
  const [moveTarget, setMoveTarget] = useState('');

  const replaceCount = replacements.size;
  const deleteCount = deletions.size;
  const insertCount = insertions.length;
  const outputPages = totalPages - deleteCount + insertCount;

  const isDefaultOrder = pageOrder.length === totalPages && pageOrder.every((pn, i) => pn === i + 1);
  const movedCount = isDefaultOrder ? 0 : pageOrder.filter((pn, i) => pn !== i + 1).length;
  const anySelected = selectedPages.size > 0;

  // Use pageOrder for display sequence
  const orderedPages = pageOrder.length === totalPages
    ? pageOrder
    : Array.from({ length: totalPages }, (_, i) => i + 1);

  // Build flat list of grid items
  type GridItem =
    | { kind: 'inserted'; insertion: Insertion; key: string }
    | { kind: 'page'; pageNum: number; key: string };

  const items: GridItem[] = [];

  // Insertions before page 1 (afterPage=0)
  for (const ins of insertions.filter((i) => i.afterPage === 0)) {
    items.push({ kind: 'inserted', insertion: ins, key: `inserted-${ins.id}` });
  }

  for (const pageNum of orderedPages) {
    items.push({ kind: 'page', pageNum, key: `page-${pageNum}` });

    // Insertions after this page
    for (const ins of insertions.filter((ins) => ins.afterPage === pageNum)) {
      items.push({ kind: 'inserted', insertion: ins, key: `inserted-${ins.id}` });
    }
  }

  const handleMoveSubmit = useCallback(() => {
    const val = parseInt(moveTarget, 10);
    if (!isNaN(val) && val >= 0 && val <= totalPages) {
      onMoveTo(val);
      setMoveTarget('');
    }
  }, [moveTarget, totalPages, onMoveTo]);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2
            className="text-sm font-semibold uppercase tracking-wider"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            Pages
          </h2>
          {!locked && (
            <button
              type="button"
              onClick={onOpenFullscreen}
              className="focus-ring flex items-center gap-1.5 text-xs font-medium px-2.5 py-1"
              style={{
                background: 'var(--color-primary-subtle)',
                color: 'var(--color-primary)',
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
          )}
          {movedCount > 0 && !locked && (
            <button
              type="button"
              onClick={onResetOrder}
              className="focus-ring flex items-center gap-1.5 text-xs font-medium px-2.5 py-1"
              style={{
                background: 'var(--color-surface-inset)',
                color: 'var(--color-ink-muted)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-border)',
                cursor: 'pointer',
              }}
            >
              Reset order
            </button>
          )}
        </div>
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
          {movedCount > 0 && (
            <span
              className="text-xs font-medium px-2.5 py-1"
              style={{
                background: 'oklch(55% 0.22 250 / 0.12)',
                color: 'oklch(45% 0.22 250)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {movedCount} moved
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
          paddingBottom: anySelected ? 72 : 0,
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
          const isSelected = selectedPages.has(pageNum);
          return (
            <div key={item.key} style={{ position: 'relative' }}>
              <PageThumbnail
                pdf={pdf}
                pageNumber={pageNum}
                totalPages={totalPages}
                replacement={replacements.get(pageNum) ?? null}
                locked={locked}
                isDeleted={deletions.has(pageNum)}
                isSelected={isSelected}
                anySelected={anySelected}
                onToggleSelect={onToggleSelect}
                onPageClick={onPageClick}
                onReplace={onReplace}
                onUndoReplace={onUndoReplace}
                onDelete={onDelete}
                onUndoDelete={onUndoDelete}
              />
              {/* Selection checkbox */}
              {!locked && !deletions.has(pageNum) && (
                <div
                  onClick={(e) => { e.stopPropagation(); onToggleSelect(pageNum); }}
                  style={{
                    position: 'absolute',
                    top: -5,
                    right: -5,
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    border: isSelected ? 'none' : '2px solid oklch(60% 0 0 / 0.4)',
                    background: isSelected ? 'oklch(55% 0.22 250)' : 'oklch(100% 0 0 / 0.85)',
                    cursor: 'pointer',
                    zIndex: 25,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: '0 1px 3px oklch(0% 0 0 / 0.15)',
                    transition: 'transform 100ms, background 100ms',
                  }}
                  title={isSelected ? 'Deselect page' : 'Select page for moving'}
                >
                  {isSelected && (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="2.5 6 5 8.5 9.5 3.5" />
                    </svg>
                  )}
                </div>
              )}
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

      {/* Floating move bar */}
      {anySelected && !locked && (
        <div
          style={{
            position: 'sticky',
            bottom: 0,
            left: 0,
            right: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            padding: '10px 16px',
            background: 'var(--color-surface-card)',
            borderTop: '1px solid var(--color-border)',
            boxShadow: '0 -2px 8px oklch(0% 0 0 / 0.1)',
            borderRadius: 'var(--radius-md) var(--radius-md) 0 0',
            zIndex: 30,
          }}
        >
          <span className="text-sm font-medium" style={{ color: 'var(--color-ink)' }}>
            {selectedPages.size} {selectedPages.size === 1 ? 'page' : 'pages'} selected
          </span>
          <span className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>
            Move after page:
          </span>
          <input
            type="text"
            value={moveTarget}
            onChange={(e) => setMoveTarget(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleMoveSubmit(); }}
            placeholder="0"
            className="focus-ring text-center text-sm font-medium"
            style={{
              width: 56,
              padding: '4px 6px',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-surface-inset)',
              color: 'var(--color-ink)',
            }}
          />
          <button
            type="button"
            onClick={handleMoveSubmit}
            className="focus-ring text-xs font-medium px-3 py-1.5"
            style={{
              background: 'var(--color-primary)',
              color: '#fff',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
            }}
          >
            Move
          </button>
          <button
            type="button"
            onClick={onClearSelection}
            className="focus-ring text-xs font-medium px-3 py-1.5"
            style={{
              background: 'var(--color-surface-inset)',
              color: 'var(--color-ink-muted)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
