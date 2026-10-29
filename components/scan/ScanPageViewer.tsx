'use client';

import { useEffect, useRef, useState } from 'react';
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

const GAP = 16;        // px between pages
const MAX_WIDTH = 1400; // "fit width" never wider than this

type Fit = 'page' | 'width';

/**
 * Page reader: every page of the book stacked vertically, scrolled with the
 * mouse wheel / scrollbar / keys. The toolbar acts on the page in view.
 * Keys: ← → or PgUp PgDn = previous / next page, Home / End, Esc = close.
 */
export function ScanPageViewer({
  sessionId, pages, index, onClose, onOverride, onDelete,
}: {
  sessionId: string;
  pages: ScanPageView[];
  /** page to open at */
  index: number;
  onClose: () => void;
  onOverride: (p: ScanPageView, o: PageOverride) => void;
  onDelete: (p: ScanPageView) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const ratios = useRef<Map<number, number>>(new Map());
  const [current, setCurrent] = useState(index);
  const currentRef = useRef(index);
  useEffect(() => { currentRef.current = current; }, [current]);
  const [fit, setFit] = useState<Fit>('page');
  const [box, setBox] = useState({ w: 1200, h: 700 });

  // size of the scroll area (pages are sized from it)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // which page is in view: the one with the largest visible share
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) ratios.current.set(Number((e.target as HTMLElement).dataset.index), e.intersectionRatio);
      let best = currentRef.current;
      let bestR = -1;
      for (const [i, r] of ratios.current) if (r > bestR) { best = i; bestR = r; }
      if (bestR > 0) setCurrent(best);
    }, { root, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] });
    itemRefs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [pages.length]);

  const go = (i: number, smooth = true) => {
    const j = Math.max(0, Math.min(pages.length - 1, i));
    itemRefs.current[j]?.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
  };

  // open at the requested page; keep the current page in view when the zoom
  // or the window size changes (page sizes change with both)
  useEffect(() => { go(currentRef.current, false); }, [fit, box.w, box.h]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = currentRef.current;
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' || e.key === 'PageDown') go(c + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(c - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(pages.length - 1);
      else return;  // ↑ ↓ and the wheel scroll normally
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pages.length, onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  const ci = Math.min(current, pages.length - 1);
  const p = pages[ci];
  if (!p) return null;
  const info = p.info;
  const b = badgeFor(p);

  const sizeOf = (q: ScanPageView) => {
    const aspect = q.info ? q.info.width / q.info.height : 0.7;
    if (fit === 'page') {
      const h = Math.max(200, box.h - 2 * GAP);
      const w = Math.min(h * aspect, box.w - 2 * GAP);
      return { w, h: w / aspect };
    }
    const w = Math.max(200, Math.min(MAX_WIDTH, box.w - 2 * GAP - 16));
    return { w, h: w / aspect };
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Pages, page ${ci + 1} of ${pages.length}`}
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: 'oklch(15% 0.02 270 / 0.95)' }}
    >
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm" style={{ color: '#fff' }}>
        <button type="button" className="focus-ring px-2 py-1" style={{ ...btn, opacity: ci === 0 ? 0.4 : 1 }} disabled={ci === 0}
          onClick={() => go(ci - 1)} aria-label="Previous page">‹</button>
        <span className="font-semibold tabular-nums">Page {ci + 1} / {pages.length}</span>
        <button type="button" className="focus-ring px-2 py-1" style={{ ...btn, opacity: ci === pages.length - 1 ? 0.4 : 1 }} disabled={ci === pages.length - 1}
          onClick={() => go(ci + 1)} aria-label="Next page">›</button>
        <span className="px-1.5 py-0.5 text-xs font-semibold" style={{ background: b.bg, color: b.fg, borderRadius: 'var(--radius-sm)' }}>{b.label}</span>
        {info && (
          <span className="text-xs" style={{ opacity: 0.8 }}>
            {info.of > 1 ? `${info.index === 1 ? 'left' : 'right'} half of a spread` : 'single page'}
            {` (${info.split.source === 'override' ? 'set by you' : `auto, ${Math.round(info.split.confidence * 100)}%`})`}
            {' · '}{info.colour ? 'colour' : 'clean'} · {info.ocrWords} words read
          </span>
        )}
        <div className="flex-1" />
        <div className="inline-flex p-0.5" style={{ background: 'var(--color-surface-inset)', borderRadius: 'var(--radius-md)' }} role="group" aria-label="Zoom">
          {(['page', 'width'] as const).map((f) => (
            <button key={f} type="button" onClick={() => setFit(f)} className="focus-ring px-2.5 py-1 text-xs font-medium"
              style={{
                background: fit === f ? 'var(--color-primary)' : 'transparent',
                color: fit === f ? '#fff' : 'var(--color-ink-muted)',
                border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
              }}>
              {f === 'page' ? 'Fit page' : 'Fit width'}
            </button>
          ))}
        </div>
        {!p.rawDeleted && !p.placeholder && (
          <button type="button" className="focus-ring px-3 py-1.5" style={btn} onClick={() => onOverride(p, { rotate: 90 })}>Rotate ⟳</button>
        )}
        {info && !p.rawDeleted && (
          <button type="button" className="focus-ring px-3 py-1.5" style={btn}
            onClick={() => onOverride(p, { split: info.of > 1 ? 'one' : 'two' })}>
            {info.of > 1 ? 'Treat as one page' : 'Split into two'}
          </button>
        )}
        <button type="button" className="focus-ring px-3 py-1.5" style={{ ...btn, color: 'var(--color-danger)' }} onClick={() => onDelete(p)}>Delete</button>
        <button type="button" className="focus-ring px-3 py-1.5" style={btn} onClick={onClose} aria-label="Close">✕</button>
      </div>
      {p.rawDeleted && (
        <p className="px-4 pb-1 text-sm" style={{ color: '#ddd' }}>
          This page was exported and its original photo removed to save space. To change it, close this and use Retake (📷) on the page.
        </p>
      )}
      {info && p.status === 'done' && !p.rawDeleted && (
        <PageOptionsBar key={`${p.id}:${p.version}`} page={p} onApply={(o) => onOverride(p, o)} />
      )}
      {info?.warnings.map((w) => (
        <p key={w} className="px-4 text-sm" style={{ color: 'oklch(85% 0.14 75)' }}>⚠ {w}</p>
      ))}

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
        <div className="flex flex-col items-center" style={{ gap: GAP, padding: GAP }}>
          {pages.map((q, i) => {
            const { w, h } = sizeOf(q);
            return (
              <div
                key={q.id}
                ref={(el) => { itemRefs.current[i] = el; }}
                data-index={i}
                className="relative flex items-center justify-center shrink-0"
                style={{
                  width: w, height: h, background: q.status === 'done' ? '#fff' : 'oklch(30% 0.02 270)',
                  boxShadow: 'var(--shadow-lg)', outline: i === ci ? '2px solid var(--color-primary)' : 'none',
                  scrollMarginTop: GAP,
                }}
              >
                {q.status === 'done' && !q.placeholder ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={imageUrl(sessionId, q.id, 'full', q.version)}
                    alt={`Page ${i + 1}`}
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full"
                    style={{ objectFit: 'contain' }}
                  />
                ) : (
                  <p className="text-sm" style={{ color: '#ddd' }}>{q.status === 'error' ? q.error : 'Still processing…'}</p>
                )}
                <span className="absolute bottom-1 right-2 text-xs tabular-nums" style={{ color: 'oklch(55% 0.015 270)' }}>{i + 1}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Options of this one page: change them and re-run just this page. */
function PageOptionsBar({ page, onApply }: { page: ScanPageView; onApply: (o: PageOverride) => void }) {
  // what the page is now: colour as it came out (Clean keeps covers in colour)
  const now = {
    colorMode: page.info?.colour ? 'colour' as const : 'clean' as const,
    dewarp: page.options.dewarp,
    removeFingers: page.options.removeFingers,
  };
  const [draft, setDraft] = useState(now);
  const changed: PageOverride = {};
  if (draft.colorMode !== now.colorMode) changed.colorMode = draft.colorMode;
  if (draft.dewarp !== now.dewarp) changed.dewarp = draft.dewarp;
  if (draft.removeFingers !== now.removeFingers) changed.removeFingers = draft.removeFingers;
  const dirty = Object.keys(changed).length > 0;
  return (
    <div
      className="mx-4 mb-1 px-3 py-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm"
      style={{ background: 'var(--color-surface-card)', color: 'var(--color-ink)', borderRadius: 'var(--radius-md)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-ink-muted)' }}>This page</span>
      <div className="flex items-center gap-3" role="radiogroup" aria-label="Colour or clean for this page">
        {(['colour', 'clean'] as const).map((m) => (
          <label key={m} className="flex items-center gap-1.5 cursor-pointer">
            <input type="radio" name="page-color-mode" className="focus-ring" checked={draft.colorMode === m}
              onChange={() => setDraft({ ...draft, colorMode: m })} />
            {m === 'colour' ? 'Colour' : 'Clean'}
          </label>
        ))}
      </div>
      <label className="flex items-center gap-1.5 cursor-pointer">
        <input type="checkbox" className="focus-ring" checked={draft.dewarp} onChange={(e) => setDraft({ ...draft, dewarp: e.target.checked })} />
        Dewarp
      </label>
      <label className="flex items-center gap-1.5 cursor-pointer">
        <input type="checkbox" className="focus-ring" checked={draft.removeFingers} onChange={(e) => setDraft({ ...draft, removeFingers: e.target.checked })} />
        Remove fingers
      </label>
      <label className="flex items-center gap-1.5" style={{ color: 'var(--color-ink-muted)' }}>
        <input type="checkbox" checked disabled readOnly />
        OCR (always on)
      </label>
      <button
        type="button"
        disabled={!dirty}
        onClick={() => onApply(changed)}
        className="focus-ring px-3 py-1.5 text-sm font-semibold"
        style={{
          background: dirty ? 'var(--color-primary)' : 'var(--color-border)',
          color: dirty ? '#fff' : 'var(--color-ink-subtle)',
          border: 'none', borderRadius: 'var(--radius-md)', cursor: dirty ? 'pointer' : 'not-allowed',
        }}
      >
        Re-run this page
      </button>
    </div>
  );
}
