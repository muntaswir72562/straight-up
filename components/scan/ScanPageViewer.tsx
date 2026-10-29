'use client';

import { useEffect } from 'react';
import type { ScanPageView } from '@/lib/scanTypes';
import { imageUrl, type PageOverride } from '@/lib/scanClient';
import { badgeFor } from './PageStrip';

const btn = {
  background: 'var(--color-surface-card)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 'var(--radius-md)',
  color: 'var(--color-ink)',
  cursor: 'pointer',
} as const;

export function ScanPageViewer({
  sessionId, pages, index, onNavigate, onClose, onOverride, onDelete,
}: {
  sessionId: string;
  pages: ScanPageView[];
  index: number;
  onNavigate: (i: number) => void;
  onClose: () => void;
  onOverride: (p: ScanPageView, o: PageOverride) => void;
  onDelete: (p: ScanPageView) => void;
}) {
  const p = pages[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && index > 0) onNavigate(index - 1);
      else if (e.key === 'ArrowRight' && index < pages.length - 1) onNavigate(index + 1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [index, pages.length, onClose, onNavigate]);

  if (!p) return null;
  const info = p.info;
  const b = badgeFor(p);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Page ${index + 1}`}
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: 'oklch(15% 0.02 270 / 0.92)' }}
      onClick={onClose}
    >
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm" style={{ color: '#fff' }} onClick={(e) => e.stopPropagation()}>
        <span className="font-semibold">Page {index + 1} / {pages.length}</span>
        <span className="px-1.5 py-0.5 text-xs font-semibold" style={{ background: b.bg, color: b.fg, borderRadius: 'var(--radius-sm)' }}>{b.label}</span>
        {info && (
          <span className="text-xs" style={{ opacity: 0.8 }}>
            {info.of > 1 ? `${info.index === 1 ? 'left' : 'right'} half of a spread` : 'single page'}
            {` (${info.split.source === 'override' ? 'set by you' : `auto, ${Math.round(info.split.confidence * 100)}%`})`}
            {' · '}{info.colour ? 'colour' : 'clean'} · {info.ocrWords} words read
          </span>
        )}
        <div className="flex-1" />
        <button type="button" className="focus-ring px-3 py-1.5" style={btn} onClick={() => onOverride(p, { rotate: 90 })}>Rotate ⟳</button>
        {info && (
          <button type="button" className="focus-ring px-3 py-1.5" style={btn}
            onClick={() => onOverride(p, { split: info.of > 1 ? 'one' : 'two' })}>
            {info.of > 1 ? 'Treat as one page' : 'Split into two'}
          </button>
        )}
        {info && (
          <button type="button" className="focus-ring px-3 py-1.5" style={btn}
            onClick={() => onOverride(p, { keepColour: !info.colour })}>
            {info.colour ? 'Clean this page' : 'Keep colour'}
          </button>
        )}
        <button type="button" className="focus-ring px-3 py-1.5" style={btn} onClick={() => onOverride(p, { dewarp: false })}>Re-run without dewarp</button>
        <button type="button" className="focus-ring px-3 py-1.5" style={{ ...btn, color: 'var(--color-danger)' }} onClick={() => onDelete(p)}>Delete</button>
        <button type="button" className="focus-ring px-3 py-1.5" style={btn} onClick={onClose} aria-label="Close">✕</button>
      </div>
      {info?.warnings.map((w) => (
        <p key={w} className="px-4 text-sm" style={{ color: 'oklch(85% 0.14 75)' }}>⚠ {w}</p>
      ))}
      <div className="relative flex-1 flex items-center justify-center min-h-0 p-4">
        <button type="button" disabled={index === 0} onClick={(e) => { e.stopPropagation(); onNavigate(index - 1); }}
          className="focus-ring absolute left-3 px-3 py-6 text-2xl" style={{ ...btn, opacity: index === 0 ? 0.3 : 0.9 }} aria-label="Previous page">‹</button>
        {p.placeholder || p.status !== 'done' ? (
          <p style={{ color: '#ddd' }}>{p.status === 'error' ? p.error : 'Still processing…'}</p>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl(sessionId, p.id, 'full', p.version)}
            alt={`Page ${index + 1}`}
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', background: '#fff', boxShadow: 'var(--shadow-lg)' }}
          />
        )}
        <button type="button" disabled={index === pages.length - 1} onClick={(e) => { e.stopPropagation(); onNavigate(index + 1); }}
          className="focus-ring absolute right-3 px-3 py-6 text-2xl" style={{ ...btn, opacity: index === pages.length - 1 ? 0.3 : 0.9 }} aria-label="Next page">›</button>
      </div>
    </div>
  );
}
