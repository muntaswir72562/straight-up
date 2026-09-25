'use client';

import dynamic from 'next/dynamic';

const BookScanTool = dynamic(
  () => import('./BookScanTool').then((mod) => mod.BookScanTool),
  {
    ssr: false,
    loading: () => (
      <div className="flex flex-1 items-center justify-center" role="status">
        <p style={{ color: 'var(--color-ink-muted)' }}>Loading...</p>
      </div>
    ),
  }
);

export function ClientApp() {
  return <BookScanTool />;
}
