export interface SlotData {
  id: string;
  number: number;
  file: File | null;
  pageCount: number | null;
  error: string | null;
  isValidating: boolean;
}

export type AppStatus =
  | 'idle'
  | 'preparing'
  | 'processing'
  | 'done'
  | 'cancelled'
  | 'error';

export interface Progress {
  current: number;
  total: number;
}

// --- Manual Fix types ---

export interface ManualFixLevels {
  blackPoint: number; // 0-255
  whitePoint: number; // 0-255
}

export interface ManualFixPageEdit {
  rotation: number;      // degrees, -10 to +10
  perspectiveX: number;  // degrees, -15 to +15
  perspectiveY: number;  // degrees, -15 to +15
}

export interface ManualFixSettings {
  levels: ManualFixLevels;
  edits: Record<number, ManualFixPageEdit>; // 1-based page number → edit (sparse)
}

export const DEFAULT_MANUAL_FIX_LEVELS: ManualFixLevels = {
  blackPoint: 0,
  whitePoint: 255,
};

export const DEFAULT_PAGE_EDIT: ManualFixPageEdit = {
  rotation: 0,
  perspectiveX: 0,
  perspectiveY: 0,
};

export function createEmptyManualFixSettings(): ManualFixSettings {
  return {
    levels: { ...DEFAULT_MANUAL_FIX_LEVELS },
    edits: {},
  };
}

export function hasManualEdits(settings: ManualFixSettings): boolean {
  const { levels, edits } = settings;
  if (levels.blackPoint !== 0 || levels.whitePoint !== 255) return true;
  return Object.keys(edits).length > 0;
}

// --- Output types ---

export interface OutputPage {
  sourceSlotId: string;
  sourcePageIndex: number;
  originalSizePoints: { width: number; height: number };
  detectedAngle: number;
  appliedAngle: number;
  untouched: boolean;
  method: 'text' | 'edge' | 'none';
  confidence: number;
  thumbnailUrl: string | null;
  jpegBytes: Uint8Array | null;
}
