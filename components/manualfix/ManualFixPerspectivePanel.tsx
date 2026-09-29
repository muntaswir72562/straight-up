'use client';

interface ManualFixPerspectivePanelProps {
  rotateX: number;
  rotateY: number;
  onChange: (perspectiveX: number, perspectiveY: number) => void;
  disabled: boolean;
}

export function ManualFixPerspectivePanel({
  rotateX,
  rotateY,
  onChange,
  disabled,
}: ManualFixPerspectivePanelProps) {
  const hasEdits = rotateX !== 0 || rotateY !== 0;

  return (
    <div className="flex flex-col gap-3">
      <p
        className="text-xs font-semibold uppercase tracking-wider"
        style={{ color: 'var(--color-ink-muted)' }}
      >
        Perspective (This Page)
      </p>

      {/* X axis */}
      <label className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-xs" style={{ color: 'var(--color-ink)' }}>Tilt Forward / Back</span>
          <span className="text-xs font-mono" style={{ color: 'var(--color-ink-muted)' }}>
            {rotateX.toFixed(1)}&deg;
          </span>
        </div>
        <input
          type="range"
          min={-15}
          max={15}
          step={0.5}
          value={rotateX}
          onChange={(e) => onChange(Number(e.target.value), rotateY)}
          disabled={disabled}
          className="manualfix-slider"
        />
      </label>

      {/* Y axis */}
      <label className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-xs" style={{ color: 'var(--color-ink)' }}>Tilt Left / Right</span>
          <span className="text-xs font-mono" style={{ color: 'var(--color-ink-muted)' }}>
            {rotateY.toFixed(1)}&deg;
          </span>
        </div>
        <input
          type="range"
          min={-15}
          max={15}
          step={0.5}
          value={rotateY}
          onChange={(e) => onChange(rotateX, Number(e.target.value))}
          disabled={disabled}
          className="manualfix-slider"
        />
      </label>

      <button
        type="button"
        onClick={() => onChange(0, 0)}
        disabled={disabled || !hasEdits}
        className="text-xs py-1.5 px-3 font-medium transition-colors self-start"
        style={{
          background: 'transparent',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--color-ink-muted)',
          cursor: disabled || !hasEdits ? 'default' : 'pointer',
          opacity: disabled || !hasEdits ? 0.5 : 1,
        }}
      >
        Reset
      </button>
    </div>
  );
}
