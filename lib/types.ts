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
