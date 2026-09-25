'use client';

import { useRef, useState, useCallback } from 'react';
import type { SlotData } from '@/lib/types';

interface SlotProps {
  slot: SlotData;
  index: number;
  locked: boolean;
  onFileDrop: (slotIndex: number, files: File[]) => void;
  onFileSelect: (slotIndex: number, file: File) => void;
  onClearSlot: (slotIndex: number) => void;
}

function truncateFilename(name: string, maxLength = 20): string {
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

export function Slot({ slot, index, locked, onFileDrop, onFileSelect, onClearSlot }: SlotProps) {
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

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    },
    []
  );

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
      if (files.length > 0) onFileDrop(index, files);
    },
    [locked, index, onFileDrop]
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
      const file = e.target.files?.[0];
      if (file) onFileSelect(index, file);
      // Reset so the same file can be re-selected
      e.target.value = '';
    },
    [index, onFileSelect]
  );

  const handleClear = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (locked) return;
      onClearSlot(index);
    },
    [locked, index, onClearSlot]
  );

  const hasFile = slot.file !== null;
  const hasError = slot.error !== null;

  // Determine visual state
  let bgColor = 'var(--color-drop-idle)';
  let borderColor = 'var(--color-drop-border)';
  let borderStyle = 'dashed';
  let borderWidth = '2px';
  let transform = 'none';
  let shadow = 'none';

  if (isDragOver && !locked) {
    bgColor = 'var(--color-drop-hover)';
    borderColor = 'var(--color-drop-border-hover)';
    transform = 'translateY(-2px) scale(1.02)';
    shadow = 'var(--shadow-lg)';
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
    shadow = 'var(--shadow-sm)';
  }

  return (
    <div
      role="button"
      tabIndex={locked ? -1 : 0}
      aria-label={
        hasFile
          ? `Slot ${slot.number}: ${slot.file!.name}, ${slot.pageCount ?? '...'} pages`
          : `Slot ${slot.number}: empty, drop PDF here or click to browse`
      }
      className={`slot-dropzone focus-ring relative flex flex-col items-center justify-center cursor-pointer select-none ${
        slot.isValidating ? 'slot-validating' : ''
      }`}
      style={{
        aspectRatio: '1',
        background: bgColor,
        border: `${borderWidth} ${borderStyle} ${borderColor}`,
        borderRadius: 'var(--radius-lg)',
        transform,
        boxShadow: shadow,
        opacity: locked ? 0.6 : 1,
        pointerEvents: locked ? 'none' : 'auto',
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
      />

      {/* Slot number badge */}
      {hasFile || hasError ? (
        <span
          className="absolute top-2 left-2.5 text-xs font-bold"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          {slot.number}
        </span>
      ) : (
        <span
          className="text-4xl font-bold leading-none"
          style={{ color: 'var(--color-ink-subtle)', opacity: 0.5 }}
        >
          {slot.number}
        </span>
      )}

      {/* Empty state */}
      {!hasFile && !hasError && !slot.isValidating && (
        <p
          className="mt-2 text-xs text-center px-2 leading-snug"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          Drop PDF here
          <br />
          or click
        </p>
      )}

      {/* Validating state */}
      {slot.isValidating && (
        <div className="flex flex-col items-center gap-1">
          <div
            className="w-5 h-5 rounded-full border-2 border-t-transparent animate-spin"
            style={{ borderColor: 'var(--color-primary)', borderTopColor: 'transparent' }}
          />
          <p className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>
            Checking...
          </p>
        </div>
      )}

      {/* Filled state */}
      {hasFile && !slot.isValidating && (
        <div className="flex flex-col items-center gap-1.5 px-3 text-center w-full">
          {/* File icon */}
          <svg
            width="24"
            height="24"
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

          <p
            className="text-xs font-medium truncate w-full"
            title={slot.file!.name}
            style={{ color: 'var(--color-ink)' }}
          >
            {truncateFilename(slot.file!.name)}
          </p>

          {slot.pageCount !== null && (
            <span
              className="inline-flex items-center px-2 py-0.5 text-xs font-medium"
              style={{
                background: 'var(--color-accent-subtle)',
                color: 'var(--color-accent-hover)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {slot.pageCount} {slot.pageCount === 1 ? 'page' : 'pages'}
            </span>
          )}
        </div>
      )}

      {/* Error state */}
      {hasError && !slot.isValidating && (
        <div className="flex flex-col items-center gap-1 px-3 text-center">
          <svg
            width="20"
            height="20"
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
          <p className="text-xs leading-snug" style={{ color: 'var(--color-danger)' }}>
            {slot.error}
          </p>
        </div>
      )}

      {/* Clear button */}
      {(hasFile || hasError) && !locked && (
        <button
          type="button"
          onClick={handleClear}
          className="focus-ring absolute top-1.5 right-1.5 flex items-center justify-center w-6 h-6 transition-colors"
          style={{
            background: 'var(--color-surface-inset)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--color-ink-muted)',
          }}
          aria-label={`Clear slot ${slot.number}`}
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
