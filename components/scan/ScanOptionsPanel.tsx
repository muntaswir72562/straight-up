'use client';

import type { ScanOptions, SplitMode } from '@/lib/scanTypes';

const HELP = 'Options for the next scan. Every page keeps the options it was scanned with; '
  + 'open a page to change them for that page only. Clean: white background, no bleed-through; '
  + 'covers and illustrations stay in colour automatically.';

/** One compact row: the options the next scan is taken with. */
export function ScanOptionsPanel({
  options, onChange, disabled,
}: { options: ScanOptions; onChange: (o: ScanOptions) => void; disabled?: boolean }) {
  const set = (patch: Partial<ScanOptions>) => onChange({ ...options, ...patch });
  return (
    <fieldset
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2 text-sm"
      style={{
        background: 'var(--color-surface-card)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        color: 'var(--color-ink)',
        opacity: disabled ? 0.6 : 1,
      }}
      disabled={disabled}
      aria-label="Options for the next scan"
    >
      <span
        className="text-xs font-semibold uppercase tracking-wider cursor-help"
        style={{ color: 'var(--color-ink-muted)' }}
        title={HELP}
      >
        Next scan ⓘ
      </span>
      <div className="flex items-center gap-3" role="radiogroup" aria-label="Colour or clean">
        {(['colour', 'clean'] as const).map((m) => (
          <label key={m} className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              name="scan-color-mode"
              className="focus-ring"
              checked={options.colorMode === m}
              onChange={() => set({ colorMode: m })}
            />
            {m === 'colour' ? 'Colour' : 'Clean'}
          </label>
        ))}
      </div>
      <label className="flex items-center gap-1.5 cursor-pointer">
        <input type="checkbox" className="focus-ring" checked={options.dewarp} onChange={(e) => set({ dewarp: e.target.checked })} />
        Dewarp
      </label>
      <label className="flex items-center gap-1.5 cursor-pointer">
        <input type="checkbox" className="focus-ring" checked={options.removeFingers} onChange={(e) => set({ removeFingers: e.target.checked })} />
        Remove fingers
      </label>
      <label className="flex items-center gap-1.5">
        Split
        <select
          value={options.split}
          onChange={(e) => set({ split: e.target.value as SplitMode })}
          className="focus-ring px-1.5 py-0.5 text-sm"
          style={{ background: 'var(--color-surface-inset)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', color: 'var(--color-ink)' }}
        >
          <option value="auto">Auto</option>
          <option value="one">Always one page</option>
          <option value="two">Always two pages</option>
        </select>
      </label>
      <label className="flex items-center gap-1.5" title="Every page is OCR'd, so the exported PDF is searchable" style={{ color: 'var(--color-ink-muted)' }}>
        <input type="checkbox" checked disabled readOnly />
        OCR (always on)
      </label>
    </fieldset>
  );
}
