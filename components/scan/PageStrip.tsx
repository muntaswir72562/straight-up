'use client';

import { useState } from 'react';
import type { ScanPageView } from '@/lib/scanTypes';
import { imageUrl } from '@/lib/scanClient';

export type PageAction = 'delete' | 'retake' | 'rotate' | 'split' | 'unsplit' | 'retry' | 'left' | 'right';

const BADGE: Record<string, { label: string; bg: string; fg: string }> = {
  queued: { label: 'Queued', bg: 'var(--color-surface-inset)', fg: 'var(--color-ink-muted)' },
  processing: { label: 'Processing', bg: 'var(--color-primary-subtle)', fg: 'var(--color-primary)' },
  done: { label: 'Done', bg: 'oklch(94% 0.05 155)', fg: 'var(--color-success)' },
  warning: { label: '⚠ Check', bg: 'var(--color-accent-subtle)', fg: 'oklch(45% 0.12 60)' },
  error: { label: 'Error', bg: 'var(--color-danger-subtle)', fg: 'var(--color-danger)' },
};

export function badgeFor(p: ScanPageView) {
  if (p.status === 'done' && p.info?.warnings.length) return BADGE.warning;
  return BADGE[p.status] ?? BADGE.error;
}

function IconButton({ label, onClick, children, danger }: { label: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="focus-ring flex items-center justify-center text-xs"
      style={{
        width: 26, height: 26,
        background: 'var(--color-surface-card)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        color: danger ? 'var(--color-danger)' : 'var(--color-ink-muted)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

export function PageStrip({
  sessionId, pages, retakeTarget, onOpen, onAction, onMove,
}: {
  sessionId: string;
  pages: ScanPageView[];
  retakeTarget: string | null;
  onOpen: (index: number) => void;
  onAction: (page: ScanPageView, action: PageAction) => void;
  onMove: (from: number, to: number) => void;
}) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  if (pages.length === 0) {
    return (
      <p className="p-6 text-center text-sm" style={{ color: 'var(--color-ink-subtle)' }}>
        No pages yet. Put the book under the camera and press <b>Scan</b> or the <b>Space</b> bar.
      </p>
    );
  }

  return (
    <ol className="grid gap-3 p-1" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(118px, 1fr))' }}>
      {pages.map((p, i) => {
        const b = badgeFor(p);
        const isTarget = retakeTarget === p.id;
        const spreadHalf = (p.info?.of ?? 1) > 1;
        return (
          <li
            key={p.id}
            draggable
            onDragStart={(e) => { setDragFrom(i); e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(e) => { if (dragFrom !== null) { e.preventDefault(); setDragOver(i); } }}
            onDragLeave={() => setDragOver((v) => (v === i ? null : v))}
            onDrop={(e) => { e.preventDefault(); if (dragFrom !== null && dragFrom !== i) onMove(dragFrom, i); setDragFrom(null); setDragOver(null); }}
            onDragEnd={() => { setDragFrom(null); setDragOver(null); }}
            className="group flex flex-col"
            style={{
              background: 'var(--color-surface-card)',
              border: `${isTarget || dragOver === i ? 2 : 1}px solid ${isTarget ? 'var(--color-accent)' : dragOver === i ? 'var(--color-primary)' : 'var(--color-border)'}`,
              borderRadius: 'var(--radius-md)',
              opacity: dragFrom === i ? 0.4 : 1,
            }}
          >
            <button
              type="button"
              onClick={() => onOpen(i)}
              disabled={p.placeholder}
              className="focus-ring relative block w-full overflow-hidden"
              style={{
                aspectRatio: '3 / 4',
                background: 'var(--color-surface-inset)',
                borderRadius: 'var(--radius-md) var(--radius-md) 0 0',
                border: 'none',
                cursor: p.placeholder ? 'default' : 'zoom-in',
                padding: 0,
              }}
              aria-label={`Page ${i + 1}, ${b.label}`}
            >
              {!p.placeholder && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={imageUrl(sessionId, p.id, 'thumb', p.version)}
                  alt=""
                  loading="lazy"
                  className="w-full h-full"
                  style={{ objectFit: 'contain', opacity: p.status === 'done' ? 1 : 0.45 }}
                />
              )}
              {p.status !== 'done' && (
                <span className="absolute inset-0 flex items-center justify-center px-2 text-center text-xs" style={{ color: 'var(--color-ink-muted)' }}>
                  {p.status === 'processing' ? (p.stage ? `${p.stage}…` : 'Processing…') : p.status === 'queued' ? 'Waiting…' : ''}
                </span>
              )}
              <span
                className="absolute top-1 left-1 px-1.5 py-0.5 text-[10px] font-semibold"
                style={{ background: b.bg, color: b.fg, borderRadius: 'var(--radius-sm)' }}
              >
                {b.label}
              </span>
            </button>
            <div className="flex items-center justify-between px-1.5 pt-1 text-xs" style={{ color: 'var(--color-ink-muted)' }}>
              <span className="font-medium" style={{ color: 'var(--color-ink)' }}>{i + 1}</span>
              {spreadHalf && <span title="From a two-page spread">{p.info!.index === 1 ? 'L' : 'R'}</span>}
            </div>
            <p className="px-1.5 text-[10px] leading-tight" style={{ color: 'var(--color-ink-subtle)' }} title="This page's options">
              {(p.info ? p.info.colour : p.options.colorMode === 'colour') ? 'Colour' : 'Clean'}
              {p.options.dewarp ? '' : ' · no dewarp'}
              {p.options.removeFingers ? '' : ' · fingers kept'}
            </p>
            {p.status === 'error' && p.error && (
              <p className="px-1.5 text-[10px] leading-tight" style={{ color: 'var(--color-danger)' }}>{p.error}</p>
            )}
            {p.info?.warnings.map((w) => (
              <p key={w} className="px-1.5 text-[10px] leading-tight" style={{ color: 'oklch(45% 0.12 60)' }}>{w}</p>
            ))}
            <div className="flex flex-wrap gap-1 p-1.5">
              {p.status === 'error' ? (
                <IconButton label="Try again" onClick={() => onAction(p, 'retry')}>↻</IconButton>
              ) : (
                <IconButton label="Rotate 90°" onClick={() => onAction(p, 'rotate')}>⟳</IconButton>
              )}
              {!p.placeholder && (spreadHalf
                ? <IconButton label="Split wrongly: treat as one page" onClick={() => onAction(p, 'unsplit')}>▢</IconButton>
                : <IconButton label="Split into two pages" onClick={() => onAction(p, 'split')}>◫</IconButton>)}
              <IconButton label={isTarget ? 'Cancel retake' : 'Retake: next scan replaces this page'} onClick={() => onAction(p, 'retake')}>
                {isTarget ? '✕' : '📷'}
              </IconButton>
              <IconButton label="Move left" onClick={() => onAction(p, 'left')}>‹</IconButton>
              <IconButton label="Move right" onClick={() => onAction(p, 'right')}>›</IconButton>
              <IconButton label="Delete page" danger onClick={() => onAction(p, 'delete')}>🗑</IconButton>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
