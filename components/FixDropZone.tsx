'use client';

import { useRef, useState, useCallback } from 'react';

interface FixDropZoneProps {
  file: File | null;
  pageCount: number | null;
  error: string | null;
  isValidating: boolean;
  locked: boolean;
  onFileChange: (file: File | null) => void;
  multiple?: boolean;
  onMultiFileAdd?: (files: File[]) => void;
}

function truncateFilename(name: string, maxLength = 40): string {
  if (name.length <= maxLength) return name;
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex > 0 && name.length - dotIndex <= 5) {
    const stem = name.slice(0, dotIndex);
    const ext = name.slice(dotIndex);
    const available = maxLength - ext.length - 1;
    if (available > 3) {
      return stem.slice(0, available) + '\u2026' + ext;
    }
  }
  return name.slice(0, maxLength - 1) + '\u2026';
}

export function FixDropZone({ file, pageCount, error, isValidating, locked, onFileChange, multiple, onMultiFileAdd }: FixDropZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      const pdfs = files.filter(
        (f) => f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf'
      );

      if (files.length > 0 && pdfs.length === 0) {
        onFileChange(null);
        return;
      }

      if (multiple && onMultiFileAdd && pdfs.length > 0) {
        onMultiFileAdd(pdfs);
      } else if (pdfs.length > 0) {
        onFileChange(pdfs[0]);
      }
    },
    [locked, onFileChange, multiple, onMultiFileAdd]
  );

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
      const files = Array.from(e.target.files ?? []);
      if (multiple && onMultiFileAdd && files.length > 0) {
        onMultiFileAdd(files);
      } else if (files.length > 0) {
        onFileChange(files[0]);
      }
      e.target.value = '';
    },
    [onFileChange, multiple, onMultiFileAdd]
  );

  const handleClear = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (locked) return;
      onFileChange(null);
    },
    [locked, onFileChange]
  );

  const hasFile = file !== null;
  const hasError = error !== null;

  let bgColor = 'var(--color-drop-idle)';
  let borderColor = 'var(--color-drop-border)';
  let borderStyle = 'dashed';
  let borderWidth = '2px';

  if (isDragOver && !locked) {
    bgColor = 'var(--color-drop-hover)';
    borderColor = 'var(--color-drop-border-hover)';
  } else if (hasError) {
    bgColor = 'var(--color-danger-subtle)';
    borderColor = 'var(--color-danger)';
    borderStyle = 'solid';
    borderWidth = '1.5px';
  } else if (hasFile) {
    bgColor = 'var(--color-surface-card)';
    borderColor = 'var(--color-border)';
    borderStyle = 'solid';
    borderWidth = '1.5px';
  }

  return (
    <div
      role="button"
      tabIndex={locked ? -1 : 0}
      aria-label={
        hasFile
          ? `Selected file: ${file!.name}, ${pageCount ?? '...'} pages`
          : 'Drop a PDF here or click to browse'
      }
      className={`focus-ring relative flex flex-col items-center justify-center cursor-pointer select-none ${
        isValidating ? 'slot-validating' : ''
      }`}
      style={{
        minHeight: '200px',
        background: bgColor,
        border: `${borderWidth} ${borderStyle} ${borderColor}`,
        borderRadius: 'var(--radius-xl)',
        opacity: locked ? 0.6 : 1,
        pointerEvents: locked ? 'none' : 'auto',
        transition: `background var(--duration-fast) var(--ease-out-expo), border-color var(--duration-fast) var(--ease-out-expo)`,
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
        accept=".pdf,application/pdf"
        className="hidden"
        onChange={handleFileChange}
        tabIndex={-1}
        multiple={multiple}
      />

      {/* Empty state */}
      {!hasFile && !hasError && !isValidating && (
        <div className="flex flex-col items-center gap-3 px-6 py-8">
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: 'var(--color-ink-subtle)' }}
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <polyline points="9 15 12 12 15 15" />
          </svg>
          <div className="text-center">
            <p className="text-sm font-medium" style={{ color: 'var(--color-ink-muted)' }}>
              {multiple ? 'Drop PDFs here or click to browse' : 'Drop a PDF here or click to browse'}
            </p>
            <p className="mt-1 text-xs" style={{ color: 'var(--color-ink-subtle)' }}>
              {multiple ? 'Add one or more PDFs — they will be processed one by one' : 'Upload your merged PDF to straighten rotated pages'}
            </p>
          </div>
        </div>
      )}

      {/* Validating state */}
      {isValidating && (
        <div className="flex flex-col items-center gap-2 py-8">
          <div
            className="w-6 h-6 rounded-full border-2 border-t-transparent animate-spin"
            style={{ borderColor: 'var(--color-primary)', borderTopColor: 'transparent' }}
          />
          <p className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>
            Checking PDF...
          </p>
        </div>
      )}

      {/* Filled state */}
      {hasFile && !isValidating && (
        <div className="flex items-center gap-4 px-6 py-6 w-full">
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: 'var(--color-primary)', flexShrink: 0 }}
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>

          <div className="flex-1 min-w-0">
            <p
              className="text-sm font-medium truncate"
              title={file!.name}
              style={{ color: 'var(--color-ink)' }}
            >
              {truncateFilename(file!.name)}
            </p>
            {pageCount !== null && (
              <span
                className="inline-flex items-center mt-1 px-2 py-0.5 text-xs font-medium"
                style={{
                  background: 'var(--color-accent-subtle)',
                  color: 'var(--color-accent-hover)',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                {pageCount} {pageCount === 1 ? 'page' : 'pages'}
              </span>
            )}
          </div>

          {/* Clear button */}
          {!locked && (
            <button
              type="button"
              onClick={handleClear}
              className="focus-ring flex items-center justify-center w-8 h-8 transition-colors"
              style={{
                background: 'var(--color-surface-inset)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--color-ink-muted)',
                flexShrink: 0,
              }}
              aria-label="Clear file"
            >
              <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="2" y1="2" x2="10" y2="10" />
                <line x1="10" y1="2" x2="2" y2="10" />
              </svg>
            </button>
          )}
        </div>
      )}

      {/* Error state */}
      {hasError && !isValidating && (
        <div className="flex flex-col items-center gap-2 px-6 py-8">
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: 'var(--color-danger)' }}
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          <p className="text-sm" style={{ color: 'var(--color-danger)' }}>
            {error}
          </p>
        </div>
      )}
    </div>
  );
}
