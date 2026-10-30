'use client';

import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { CropRect } from '@/lib/scanTypes';

type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const MIN = 0.05; // smallest crop side, as a fraction of the frame
const HANDLE = 14; // px

const CURSOR: Record<Handle, string> = {
  move: 'move', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
};

function clampRect(r: CropRect): CropRect {
  const w = Math.min(Math.max(r.w, MIN), 1);
  const h = Math.min(Math.max(r.h, MIN), 1);
  return { x: Math.min(Math.max(r.x, 0), 1 - w), y: Math.min(Math.max(r.y, 0), 1 - h), w, h };
}

function resize(start: CropRect, handle: Handle, dx: number, dy: number): CropRect {
  if (handle === 'move') return clampRect({ ...start, x: start.x + dx, y: start.y + dy });
  let { x, y, w, h } = start;
  const right = x + w;
  const bottom = y + h;
  if (handle.includes('w')) { x = Math.min(Math.max(start.x + dx, 0), right - MIN); w = right - x; }
  if (handle.includes('e')) { w = Math.min(Math.max(start.w + dx, MIN), 1 - x); }
  if (handle.includes('n')) { y = Math.min(Math.max(start.y + dy, 0), bottom - MIN); h = bottom - y; }
  if (handle.includes('s')) { h = Math.min(Math.max(start.h + dy, MIN), 1 - y); }
  return { x, y, w, h };
}

/**
 * Crop rectangle drawn over the live camera picture. `area` is where the
 * video frame is shown inside the preview (px); the rectangle is kept as
 * fractions of the frame, so it doesn't depend on the window size.
 */
export function CropOverlay({
  rect, area, onChange, onCommit,
}: {
  rect: CropRect;
  area: { left: number; top: number; width: number; height: number };
  onChange: (r: CropRect) => void;
  onCommit: (r: CropRect) => void;
}) {
  const drag = useRef<{ handle: Handle; x: number; y: number; start: CropRect; last: CropRect } | null>(null);

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const handle = e.currentTarget.dataset.handle as Handle;
    drag.current = { handle, x: e.clientX, y: e.clientY, start: rect, last: rect };
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || area.width <= 0 || area.height <= 0) return;
    const r = resize(d.start, d.handle, (e.clientX - d.x) / area.width, (e.clientY - d.y) / area.height);
    d.last = r;
    onChange(r);
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (d) onCommit(d.last);
  };
  // the same handlers on every grip; data-handle says which one it is
  const grip = { onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: up };

  const L = rect.x * area.width;
  const T = rect.y * area.height;
  const W = rect.w * area.width;
  const H = rect.h * area.height;
  const handle = (h: Handle, left: number | string, top: number | string, w: number | string, hh: number | string, dot = false) => (
    <div
      key={h}
      {...grip}
      data-handle={h}
      className="absolute"
      style={{ cursor: CURSOR[h], touchAction: 'none', left, top, width: w, height: hh, transform: dot ? 'translate(-50%, -50%)' : undefined }}
    >
      {dot && <div className="w-full h-full" style={{ background: '#fff', border: '2px solid var(--color-accent)', borderRadius: 3 }} />}
    </div>
  );

  return (
    <div
      // not clipped: corner handles stay grabbable at the frame edge (the preview box clips the dimming)
      className="absolute"
      style={{ left: area.left, top: area.top, width: area.width, height: area.height }}
      aria-label="Crop area: drag the corners or edges to resize, the middle to move"
    >
      <div
        {...grip}
        data-handle="move"
        className="absolute"
        style={{
          cursor: CURSOR.move, touchAction: 'none',
          left: L, top: T, width: W, height: H,
          border: '2px solid var(--color-accent)',
          boxShadow: '0 0 0 9999px oklch(0% 0 0 / 0.45)', // dims everything outside
        }}
      >
        {/* centre line, to line up the spine of an open book */}
        <div className="absolute pointer-events-none" style={{ left: '50%', top: 0, bottom: 0, borderLeft: '1px dashed oklch(100% 0 0 / 0.55)' }} />
        <span
          className="absolute left-1 top-1 px-1.5 py-0.5 text-[11px] font-medium pointer-events-none"
          style={{ background: 'var(--color-accent)', color: '#1d1f2e', borderRadius: 'var(--radius-sm)' }}
        >
          Crop area
        </span>
      </div>
      {/* edges */}
      {handle('n', L + HANDLE, T - HANDLE / 2, Math.max(0, W - 2 * HANDLE), HANDLE)}
      {handle('s', L + HANDLE, T + H - HANDLE / 2, Math.max(0, W - 2 * HANDLE), HANDLE)}
      {handle('w', L - HANDLE / 2, T + HANDLE, HANDLE, Math.max(0, H - 2 * HANDLE))}
      {handle('e', L + W - HANDLE / 2, T + HANDLE, HANDLE, Math.max(0, H - 2 * HANDLE))}
      {/* corners */}
      {handle('nw', L, T, HANDLE, HANDLE, true)}
      {handle('ne', L + W, T, HANDLE, HANDLE, true)}
      {handle('sw', L, T + H, HANDLE, HANDLE, true)}
      {handle('se', L + W, T + H, HANDLE, HANDLE, true)}
    </div>
  );
}
