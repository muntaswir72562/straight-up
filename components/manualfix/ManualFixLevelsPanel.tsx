'use client';

import type { ManualFixLevels } from '@/lib/types';

interface ManualFixLevelsPanelProps {
  levels: ManualFixLevels;
  onChange: (levels: ManualFixLevels) => void;
  disabled: boolean;
}

export function ManualFixLevelsPanel({ levels, onChange, disabled }: ManualFixLevelsPanelProps) {
  const handleBlack = (v: number) => {
    onChange({ ...levels, blackPoint: Math.min(v, levels.whitePoint - 1) });
  };

  const handleWhite = (v: number) => {
    onChange({ ...levels, whitePoint: Math.max(v, levels.blackPoint + 1) });
  };

  return (
    <div className="flex flex-col gap-3">
      <p
        className="text-xs font-semibold uppercase tracking-wider"
        style={{ color: 'var(--color-ink-muted)' }}
      >
        Levels (All Pages)
      </p>

      {/* Black point */}
      <label className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-xs" style={{ color: 'var(--color-ink)' }}>Black</span>
          <span className="text-xs font-mono" style={{ color: 'var(--color-ink-muted)' }}>
            {levels.blackPoint}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={254}
          step={1}
          value={levels.blackPoint}
          onChange={(e) => handleBlack(Number(e.target.value))}
          disabled={disabled}
          className="manualfix-slider"
        />
      </label>

      {/* White point */}
      <label className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-xs" style={{ color: 'var(--color-ink)' }}>White</span>
          <span className="text-xs font-mono" style={{ color: 'var(--color-ink-muted)' }}>
            {levels.whitePoint}
          </span>
        </div>
        <input
          type="range"
          min={1}
          max={255}
          step={1}
          value={levels.whitePoint}
          onChange={(e) => handleWhite(Number(e.target.value))}
          disabled={disabled}
          className="manualfix-slider"
        />
      </label>
    </div>
  );
}
