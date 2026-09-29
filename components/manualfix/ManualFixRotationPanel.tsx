'use client';

interface ManualFixRotationPanelProps {
  angle: number;
  onChange: (angle: number) => void;
  disabled: boolean;
}

export function ManualFixRotationPanel({ angle, onChange, disabled }: ManualFixRotationPanelProps) {
  const clamp = (v: number) => Math.round(Math.max(-10, Math.min(10, v)) * 10) / 10;

  return (
    <div className="flex flex-col gap-3">
      <p
        className="text-xs font-semibold uppercase tracking-wider"
        style={{ color: 'var(--color-ink-muted)' }}
      >
        Rotation (This Page)
      </p>

      <label className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-xs" style={{ color: 'var(--color-ink)' }}>Angle</span>
          <span className="text-xs font-mono" style={{ color: 'var(--color-ink-muted)' }}>
            {angle.toFixed(1)}&deg;
          </span>
        </div>
        <input
          type="range"
          min={-10}
          max={10}
          step={0.1}
          value={angle}
          onChange={(e) => onChange(Number(e.target.value))}
          disabled={disabled}
          className="manualfix-slider"
        />
      </label>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onChange(clamp(angle - 0.1))}
          disabled={disabled || angle <= -10}
          className="flex-1 text-xs py-1.5 font-medium transition-colors"
          style={{
            background: 'var(--color-surface-inset)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--color-ink)',
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.5 : 1,
          }}
        >
          &#8634; CCW
        </button>
        <button
          type="button"
          onClick={() => onChange(clamp(angle + 0.1))}
          disabled={disabled || angle >= 10}
          className="flex-1 text-xs py-1.5 font-medium transition-colors"
          style={{
            background: 'var(--color-surface-inset)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--color-ink)',
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.5 : 1,
          }}
        >
          CW &#8635;
        </button>
        <button
          type="button"
          onClick={() => onChange(0)}
          disabled={disabled || angle === 0}
          className="text-xs py-1.5 px-3 font-medium transition-colors"
          style={{
            background: 'transparent',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--color-ink-muted)',
            cursor: disabled || angle === 0 ? 'default' : 'pointer',
            opacity: disabled || angle === 0 ? 0.5 : 1,
          }}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
