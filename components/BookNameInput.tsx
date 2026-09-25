'use client';

interface BookNameInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}

export function BookNameInput({ value, onChange, disabled }: BookNameInputProps) {
  return (
    <div>
      <label
        htmlFor="book-name"
        className="block text-sm font-medium mb-1.5"
        style={{ color: 'var(--color-ink)' }}
      >
        Book name
      </label>
      <input
        id="book-name"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. Criminal Law of Mauritius"
        disabled={disabled}
        autoComplete="off"
        className="focus-ring w-full px-4 py-3 text-base transition-colors"
        style={{
          background: 'var(--color-surface-inset)',
          border: '1.5px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--color-ink)',
          opacity: disabled ? 0.6 : 1,
        }}
      />
      {!value.trim() && (
        <p className="mt-1.5 text-xs" style={{ color: 'var(--color-ink-subtle)' }}>
          Required — this becomes the downloaded file name.
        </p>
      )}
    </div>
  );
}
