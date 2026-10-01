'use client';

import { useRef, useCallback } from 'react';
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

function isImageFile(file: File): boolean {
  return /^image\/(jpeg|png|webp)$/.test(file.type) ||
    /\.(jpe?g|png|webp)$/i.test(file.name);
}

function InsertButton({
  afterPage,
  locked,
  onInsert,
}: {
  afterPage: number;
  locked: boolean;
  onInsert: (afterPage: number, file: File) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleClick = useCallback(() => {
    if (locked) return;
    fileInputRef.current?.click();
  }, [locked]);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f && isImageFile(f)) {
        onInsert(afterPage, f);
      }
      e.target.value = '';
    },
    [onInsert, afterPage]
  );

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        aspectRatio: '0.707',
        maxHeight: 36,
        border: '1.5px dashed var(--color-border-strong)',
        borderRadius: 'var(--radius-md)',
        cursor: locked ? 'not-allowed' : 'pointer',
        opacity: locked ? 0.4 : 0.6,
        transition: 'opacity var(--duration-fast) var(--ease-out-expo), border-color var(--duration-fast) var(--ease-out-expo)',
      }}
      onClick={handleClick}
      onMouseEnter={(e) => {
        if (!locked) {
          e.currentTarget.style.opacity = '1';
          e.currentTarget.style.borderColor = 'var(--color-primary)';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.opacity = locked ? '0.4' : '0.6';
        e.currentTarget.style.borderColor = 'var(--color-border-strong)';
      }}
      title={afterPage === 0 ? 'Insert before page 1' : `Insert after page ${afterPage}`}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        className="hidden"
        onChange={handleFileChange}
        tabIndex={-1}
      />
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        style={{ color: 'var(--color-ink-muted)' }}
      >
        <line x1="7" y1="1" x2="7" y2="13" />
        <line x1="1" y1="7" x2="13" y2="7" />
      </svg>
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

  // Build flat list of grid items
  type GridItem =
    | { kind: 'insert-button'; afterPage: number; key: string }
    | { kind: 'inserted'; insertion: Insertion; key: string }
    | { kind: 'page'; pageNum: number; key: string };

  const items: GridItem[] = [];

  // Insert button before page 1 (afterPage=0)
  items.push({ kind: 'insert-button', afterPage: 0, key: 'ins-btn-0' });

  // Insertions before page 1 (afterPage=0)
  for (const ins of insertions.filter((i) => i.afterPage === 0)) {
    items.push({ kind: 'inserted', insertion: ins, key: `inserted-${ins.id}` });
  }

  for (let i = 1; i <= totalPages; i++) {
    // Page thumbnail
    items.push({ kind: 'page', pageNum: i, key: `page-${i}` });

    // Insert button after this page
    items.push({ kind: 'insert-button', afterPage: i, key: `ins-btn-${i}` });

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
          gap: '12px',
        }}
      >
        {items.map((item) => {
          if (item.kind === 'insert-button') {
            return (
              <InsertButton
                key={item.key}
                afterPage={item.afterPage}
                locked={locked}
                onInsert={onInsert}
              />
            );
          }
          if (item.kind === 'inserted') {
            return (
              <InsertedPageThumbnail
                key={item.key}
                file={item.insertion.file}
                id={item.insertion.id}
                locked={locked}
                onRemove={onRemoveInsert}
              />
            );
          }
          // kind === 'page'
          return (
            <PageThumbnail
              key={item.key}
              pdf={pdf}
              pageNumber={item.pageNum}
              totalPages={totalPages}
              replacement={replacements.get(item.pageNum) ?? null}
              locked={locked}
              isDeleted={deletions.has(item.pageNum)}
              onReplace={onReplace}
              onUndoReplace={onUndoReplace}
              onDelete={onDelete}
              onUndoDelete={onUndoDelete}
            />
          );
        })}
      </div>
    </div>
  );
}
