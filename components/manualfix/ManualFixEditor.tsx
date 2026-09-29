'use client';

import { useState, useCallback, useMemo } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { ManualFixSettings, ManualFixLevels, ManualFixPageEdit } from '@/lib/types';
import { DEFAULT_PAGE_EDIT } from '@/lib/types';
import { ManualFixPageNav } from './ManualFixPageNav';
import { ManualFixPreview } from './ManualFixPreview';
import { ManualFixLevelsPanel } from './ManualFixLevelsPanel';
import { ManualFixRotationPanel } from './ManualFixRotationPanel';
import { ManualFixPerspectivePanel } from './ManualFixPerspectivePanel';

interface ManualFixEditorProps {
  pdf: PDFDocumentProxy;
  totalPages: number;
  locked: boolean;
  settings: ManualFixSettings;
  onSettingsChange: (settings: ManualFixSettings) => void;
}

export function ManualFixEditor({
  pdf,
  totalPages,
  locked,
  settings,
  onSettingsChange,
}: ManualFixEditorProps) {
  const [currentPage, setCurrentPage] = useState(1);

  const editedPages = useMemo(
    () => new Set(Object.keys(settings.edits).map(Number)),
    [settings.edits],
  );

  const currentEdit: ManualFixPageEdit =
    settings.edits[currentPage] ?? DEFAULT_PAGE_EDIT;

  const handleLevelsChange = useCallback(
    (levels: ManualFixLevels) => {
      onSettingsChange({ ...settings, levels });
    },
    [settings, onSettingsChange],
  );

  const updatePageEdit = useCallback(
    (edit: ManualFixPageEdit) => {
      const isDefault =
        edit.rotation === 0 && edit.perspectiveX === 0 && edit.perspectiveY === 0;

      const newEdits = { ...settings.edits };
      if (isDefault) {
        delete newEdits[currentPage];
      } else {
        newEdits[currentPage] = edit;
      }
      onSettingsChange({ ...settings, edits: newEdits });
    },
    [settings, currentPage, onSettingsChange],
  );

  const handleRotation = useCallback(
    (angle: number) => {
      updatePageEdit({ ...currentEdit, rotation: angle });
    },
    [currentEdit, updatePageEdit],
  );

  const handlePerspective = useCallback(
    (perspectiveX: number, perspectiveY: number) => {
      updatePageEdit({ ...currentEdit, perspectiveX, perspectiveY });
    },
    [currentEdit, updatePageEdit],
  );

  const handleResetPage = useCallback(() => {
    const newEdits = { ...settings.edits };
    delete newEdits[currentPage];
    onSettingsChange({ ...settings, edits: newEdits });
  }, [settings, currentPage, onSettingsChange]);

  return (
    <div className="flex flex-col gap-4">
      {/* Page navigation strip */}
      <ManualFixPageNav
        pdf={pdf}
        totalPages={totalPages}
        currentPage={currentPage}
        editedPages={editedPages}
        onPageSelect={setCurrentPage}
      />

      {/* Main editor area: preview + controls */}
      <div
        className="grid gap-4"
        style={{
          gridTemplateColumns: 'minmax(0, 1fr) 280px',
        }}
      >
        {/* Preview */}
        <ManualFixPreview
          pdf={pdf}
          pageNumber={currentPage}
          levels={settings.levels}
          rotation={currentEdit.rotation}
          perspectiveX={currentEdit.perspectiveX}
          perspectiveY={currentEdit.perspectiveY}
        />

        {/* Controls panel */}
        <div
          className="flex flex-col gap-5 p-4"
          style={{
            background: 'var(--color-surface-card)',
            border: '1.5px solid var(--color-border)',
            borderRadius: 'var(--radius-lg)',
            alignSelf: 'start',
          }}
        >
          <ManualFixLevelsPanel
            levels={settings.levels}
            onChange={handleLevelsChange}
            disabled={locked}
          />

          <hr style={{ border: 'none', borderTop: '1px solid var(--color-border)' }} />

          <ManualFixRotationPanel
            angle={currentEdit.rotation}
            onChange={handleRotation}
            disabled={locked}
          />

          <hr style={{ border: 'none', borderTop: '1px solid var(--color-border)' }} />

          <ManualFixPerspectivePanel
            rotateX={currentEdit.perspectiveX}
            rotateY={currentEdit.perspectiveY}
            onChange={handlePerspective}
            disabled={locked}
          />

          <hr style={{ border: 'none', borderTop: '1px solid var(--color-border)' }} />

          {/* Reset page button */}
          <button
            type="button"
            onClick={handleResetPage}
            disabled={locked || !editedPages.has(currentPage)}
            className="text-xs py-2 font-medium transition-colors"
            style={{
              background: 'var(--color-surface-inset)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--color-ink-muted)',
              cursor: locked || !editedPages.has(currentPage) ? 'default' : 'pointer',
              opacity: locked || !editedPages.has(currentPage) ? 0.5 : 1,
            }}
          >
            Reset This Page
          </button>
        </div>
      </div>

      {/* Responsive: stack on mobile */}
      <style>{`
        @media (max-width: 768px) {
          .grid[style*="gridTemplateColumns"] {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  );
}
