'use client';

import type { PipelinePhase } from '@/lib/pipeline';

interface ProgressPanelProps {
  phase: PipelinePhase;
  current: number;
  total: number;
  onCancel: () => void;
}

const PHASE_LABELS: Record<PipelinePhase, (current: number, total: number) => string> = {
  preparing: (c, t) => t > 0 ? `Preparing... (part ${c} of ${t})` : 'Preparing...',
  detecting: (c, t) => `Analysing page ${c} of ${t}...`,
  straightening: (c, t) => `Straightening page ${c} of ${t}...`,
  cleaning: (c, t) => `Cleaning page ${c} of ${t}...`,
  dewarping: (c, t) => `Dewarping page ${c} of ${t}...`,
  fixing: (c, t) => `Fixing page ${c} of ${t}...`,
  merging: (c, t) => `Merging page ${c} of ${t}...`,
  saving: () => 'Saving PDF...',
  ocr: (c, t) => `OCR page ${c} of ${t}...`,
  checking: () => 'Checking pages\u2026',
};

export function ProgressPanel({ phase, current, total, onCancel }: ProgressPanelProps) {
  const isIndeterminate = (phase === 'preparing' && total === 0) || phase === 'saving' || phase === 'checking';
  const percent = isIndeterminate
    ? 0
    : total > 0
      ? Math.round((current / total) * 100)
      : 0;

  const label = PHASE_LABELS[phase](current, total);

  return (
    <div
      className="w-full mx-auto p-6 sm:p-8 flex flex-col items-center gap-5"
      style={{
        maxWidth: '28rem',
        background: 'var(--color-surface-card)',
        border: '1.5px solid var(--color-border)',
        borderRadius: 'var(--radius-xl)',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      {/* Status text */}
      <p className="text-sm font-medium" style={{ color: 'var(--color-ink)' }}>
        {label}
      </p>

      {/* Progress bar */}
      <div
        className="w-full overflow-hidden"
        style={{
          height: '8px',
          background: 'var(--color-surface-inset)',
          borderRadius: '4px',
        }}
        role="progressbar"
        aria-valuenow={current}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={`Progress: ${percent}%`}
      >
        {isIndeterminate ? (
          <div
            className="h-full animate-pulse"
            style={{
              width: '40%',
              background: 'var(--color-primary)',
              borderRadius: '4px',
              opacity: 0.6,
            }}
          />
        ) : (
          <div
            className="h-full transition-all"
            style={{
              width: `${percent}%`,
              background: 'var(--color-primary)',
              borderRadius: '4px',
              transitionDuration: 'var(--duration-normal)',
              transitionTimingFunction: 'var(--ease-out-expo)',
            }}
          />
        )}
      </div>

      {/* Percentage (hidden during indeterminate phases) */}
      {!isIndeterminate && (
        <p className="text-xs font-mono" style={{ color: 'var(--color-ink-muted)' }}>
          {percent}%
        </p>
      )}

      {/* Keep-tab-open note */}
      <p className="text-xs text-center" style={{ color: 'var(--color-ink-subtle)' }}>
        Please keep this tab open until it finishes.
      </p>

      {/* Cancel button */}
      <button
        type="button"
        onClick={onCancel}
        className="focus-ring px-5 py-2 text-sm font-medium transition-colors"
        style={{
          background: 'transparent',
          border: '1.5px solid var(--color-border-strong)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--color-ink-muted)',
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = 'var(--color-danger)';
          e.currentTarget.style.color = 'var(--color-danger)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = 'var(--color-border-strong)';
          e.currentTarget.style.color = 'var(--color-ink-muted)';
        }}
      >
        Cancel
      </button>
    </div>
  );
}
