'use client';

import { useState, useEffect } from 'react';
import type { PageAngleInfo } from '@/lib/pipeline';

interface AuditIssue {
  type: 'missing' | 'duplicate' | 'info';
  confidence: 'high' | 'low';
  printed: string[];
  after_scan: number;
  before_scan: number;
  message: string;
}

interface AuditReport {
  summary: string;
  issues: AuditIssue[];
  runs: { kind: string; from_scan: number; to_scan: number; printed: string }[];
  pages: { scan: number; printed: string | null; kind: string; source: string; blank: boolean }[];
}

interface ResultPanelProps {
  filename: string;
  totalPages: number;
  downloadUrl: string;
  angles: PageAngleInfo[];
  ocrEnabled?: boolean;
  auditEnabled?: boolean;
  onStartOver: () => void;
}

export function ResultPanel({ filename, totalPages, downloadUrl, angles, ocrEnabled, auditEnabled = true, onStartOver }: ResultPanelProps) {
  const [showAngles, setShowAngles] = useState(false);
  const [audit, setAudit] = useState<AuditReport | null>(null);

  const straightened = angles.filter((a) => a.straightened).length;
  const alreadyStraight = angles.length - straightened;

  const hasSidecar = ocrEnabled && downloadUrl.startsWith('/api/');
  const isFullfixApi = downloadUrl.startsWith('/api/fullfix');

  // Fetch audit report when available
  useEffect(() => {
    if (!isFullfixApi || !auditEnabled) return;
    let cancelled = false;
    const url = `${downloadUrl}&type=audit`;
    fetch(url).then((res) => {
      if (!res.ok || cancelled) return null;
      return res.json();
    }).then((data) => {
      if (data && !cancelled) setAudit(data as AuditReport);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [downloadUrl, isFullfixApi, auditEnabled]);

  const hasIssues = audit && audit.issues.length > 0;
  const noIssues = audit && audit.issues.length === 0;

  return (
    <div
      className="w-full mx-auto flex flex-col items-center gap-5"
      style={{ maxWidth: '36rem' }}
    >
      {/* Main result card */}
      <div
        className="w-full p-6 sm:p-8 flex flex-col items-center gap-5"
        style={{
          background: 'var(--color-surface-card)',
          border: '1.5px solid var(--color-border)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-md)',
        }}
      >
        {/* Success icon */}
        <div
          className="flex items-center justify-center w-14 h-14"
          style={{
            background: 'oklch(92% 0.06 155)',
            borderRadius: '50%',
          }}
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: 'var(--color-success)' }}
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>

        {/* Summary */}
        <div className="text-center">
          <p className="text-base font-semibold" style={{ color: 'var(--color-ink)' }}>
            Your PDF is ready
          </p>
          <p className="mt-1 text-sm" style={{ color: 'var(--color-ink-muted)' }}>
            {totalPages} {totalPages === 1 ? 'page' : 'pages'} merged
            {angles.length > 0 && (
              <>
                {' '}&middot; {straightened} straightened &middot; {alreadyStraight} already straight
              </>
            )}
            {ocrEnabled && <>{' '}&middot; searchable text embedded</>}
          </p>
        </div>

        {/* Download button */}
        <a
          href={downloadUrl}
          download={filename}
          className="focus-ring flex items-center justify-center gap-2 w-full px-6 py-4 text-base font-semibold transition-all"
          style={{
            background: 'var(--color-primary)',
            color: '#ffffff',
            borderRadius: 'var(--radius-lg)',
            textDecoration: 'none',
            boxShadow: 'var(--shadow-md)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--color-primary-hover)';
            e.currentTarget.style.boxShadow = 'var(--shadow-lg)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'var(--color-primary)';
            e.currentTarget.style.boxShadow = 'var(--shadow-md)';
          }}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Download {filename}
        </a>

        {/* OCR sidecar download buttons */}
        {hasSidecar && (
          <div className="w-full flex gap-2" style={{ marginTop: '-0.5rem' }}>
            <a
              href={`${downloadUrl}&type=txt`}
              download={filename.replace(/\.pdf$/i, '_ocr.txt')}
              className="focus-ring flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors"
              style={{
                background: 'var(--color-surface-inset)',
                border: '1.5px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--color-ink-muted)',
                textDecoration: 'none',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
              </svg>
              OCR Text
            </a>
            <a
              href={`${downloadUrl}&type=json`}
              download={filename.replace(/\.pdf$/i, '_ocr.json')}
              className="focus-ring flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors"
              style={{
                background: 'var(--color-surface-inset)',
                border: '1.5px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--color-ink-muted)',
                textDecoration: 'none',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="16 18 22 12 16 6"/>
                <polyline points="8 6 2 12 8 18"/>
              </svg>
              OCR Data
            </a>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-3">
          {angles.length > 0 && (
            <button
              type="button"
              onClick={() => setShowAngles((v) => !v)}
              className="focus-ring px-4 py-2 text-sm font-medium transition-colors"
              style={{
                background: 'transparent',
                border: '1.5px solid var(--color-border-strong)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--color-ink-muted)',
                cursor: 'pointer',
              }}
            >
              {showAngles ? 'Hide' : 'Show'} detected angles
            </button>
          )}
          <button
            type="button"
            onClick={onStartOver}
            className="focus-ring px-4 py-2 text-sm font-medium transition-colors"
            style={{
              background: 'transparent',
              border: '1.5px solid var(--color-border-strong)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--color-ink-muted)',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-primary)';
              e.currentTarget.style.color = 'var(--color-primary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-border-strong)';
              e.currentTarget.style.color = 'var(--color-ink-muted)';
            }}
          >
            Start over
          </button>
        </div>
      </div>

      {/* Page check card */}
      {audit && (
        <div
          className="w-full overflow-hidden"
          style={{
            background: 'var(--color-surface-card)',
            border: `1.5px solid ${hasIssues ? 'oklch(75% 0.15 55)' : 'var(--color-border)'}`,
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-sm)',
          }}
        >
          <div className="px-4 py-3 flex items-center gap-2" style={{ borderBottom: '1px solid var(--color-border)' }}>
            {noIssues ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                stroke="oklch(55% 0.15 155)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                stroke="oklch(65% 0.18 55)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            )}
            <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-ink-muted)' }}>
              Page check
            </p>
          </div>
          <div className="px-4 py-3">
            {noIssues && (
              <p className="text-sm" style={{ color: 'oklch(45% 0.12 155)' }}>
                {audit.summary}
              </p>
            )}
            {hasIssues && (
              <div className="flex flex-col gap-2">
                {audit.issues.map((issue, i) => {
                  const isWarning = issue.confidence === 'high' && issue.type !== 'info';
                  const isMuted = issue.confidence === 'low' || issue.type === 'info';
                  return (
                    <div key={i} className="flex items-start gap-2 text-sm">
                      {isWarning && (
                        <span style={{ color: 'oklch(65% 0.18 55)', flexShrink: 0, marginTop: '2px' }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                            <line x1="12" y1="9" x2="12" y2="13"/>
                            <line x1="12" y1="17" x2="12.01" y2="17"/>
                          </svg>
                        </span>
                      )}
                      {isMuted && (
                        <span style={{ color: 'var(--color-ink-subtle)', flexShrink: 0, marginTop: '2px' }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10"/>
                            <line x1="12" y1="16" x2="12" y2="12"/>
                            <line x1="12" y1="8" x2="12.01" y2="8"/>
                          </svg>
                        </span>
                      )}
                      <span style={{ color: isWarning ? 'oklch(45% 0.12 55)' : 'var(--color-ink-subtle)' }}>
                        {isMuted && issue.type !== 'info' && 'Possible: '}
                        {issue.message}
                        {issue.type === 'missing' && (
                          <span className="text-xs" style={{ color: 'var(--color-ink-subtle)', marginLeft: '4px' }}>
                            (use Replace Pages to insert)
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Angle detection results table */}
      {showAngles && angles.length > 0 && (
        <div
          className="w-full overflow-hidden"
          style={{
            background: 'var(--color-surface-card)',
            border: '1.5px solid var(--color-border)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-sm)',
          }}
        >
          <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--color-border)' }}>
            <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-ink-muted)' }}>
              Detected angles per page
            </p>
          </div>
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <th className="px-4 py-2 text-left font-medium text-xs" style={{ color: 'var(--color-ink-subtle)' }}>Page</th>
                  <th className="px-4 py-2 text-right font-medium text-xs" style={{ color: 'var(--color-ink-subtle)' }}>Angle</th>
                  <th className="px-4 py-2 text-right font-medium text-xs" style={{ color: 'var(--color-ink-subtle)' }}>Method</th>
                </tr>
              </thead>
              <tbody>
                {angles.map((a, i) => (
                    <tr
                      key={i}
                      style={{
                        borderBottom: '1px solid var(--color-border)',
                        background: a.straightened ? 'var(--color-accent-subtle)' : 'transparent',
                      }}
                    >
                      <td className="px-4 py-1.5" style={{ color: 'var(--color-ink)' }}>
                        <span className="text-xs" style={{ color: 'var(--color-ink-subtle)' }}>Slot {a.slotNumber}, </span>
                        p.{a.pageIndex}
                      </td>
                      <td
                        className="px-4 py-1.5 text-right font-mono text-xs"
                        style={{ color: a.straightened ? 'var(--color-accent-hover)' : 'var(--color-ink-subtle)' }}
                      >
                        {a.angle >= 0 ? '+' : ''}{a.angle.toFixed(2)}&deg;
                      </td>
                      <td className="px-4 py-1.5 text-right text-xs" style={{ color: 'var(--color-ink-subtle)' }}>
                        {a.straightened ? 'fixed' : a.method}
                      </td>
                    </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
