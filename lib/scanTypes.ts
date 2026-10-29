/** Scan Book types shared by the API routes and the UI. */

export type ColorMode = 'clean' | 'colour';
export type SplitMode = 'auto' | 'one' | 'two';

export interface ScanOptions {
  colorMode: ColorMode;
  dewarp: boolean;
  removeFingers: boolean;
  split: SplitMode;
}

/** Per-capture changes made after the fact; page keys are the index within the capture (1, 2). */
export interface CaptureOverrides {
  colorMode?: ColorMode;
  dewarp?: boolean;
  removeFingers?: boolean;
  split?: SplitMode;
  rotate?: Record<string, number>;
  keepColour?: Record<string, boolean>;
}

export type CaptureStatus = 'queued' | 'processing' | 'done' | 'error';

export interface ScanCapture {
  no: number;
  options: ScanOptions;
  overrides: CaptureOverrides;
  status: CaptureStatus;
  error?: string;
  attempts: number;
  createdAt: string;
  doneAt?: string;
  /** Page ids this capture produced last time it was processed. */
  pages: string[];
  /** Page ids the user deleted (not re-added when the capture is reprocessed). */
  deleted?: string[];
}

export interface ScanPageInfo {
  capture: number;
  index: number;
  of: number;
  width: number;
  height: number;
  colour: boolean;
  warnings: string[];
  split: { spread: boolean; confidence: number; source: string };
  ocrWords: number;
}

export interface ScanSession {
  id: string;
  bookName: string;
  options: ScanOptions;
  createdAt: string;
  updatedAt: string;
  nextCapture: number;
  captures: Record<string, ScanCapture>;
  /** Page ids in book order; `cNNNN` placeholders for captures still in the queue. */
  order: string[];
  pages: Record<string, ScanPageInfo>;
  exportedAt?: string;
}

/** One entry of the page strip, as returned by GET /api/scan/session?id=… */
export interface ScanPageView {
  id: string;
  capture: number;
  placeholder: boolean;
  status: CaptureStatus;
  stage?: string;
  error?: string;
  info?: ScanPageInfo;
  /** changes when the page image changes (cache-busting for <img>) */
  version: string;
}

export interface ScanSessionView {
  id: string;
  bookName: string;
  options: ScanOptions;
  updatedAt: string;
  exportedAt?: string;
  pages: ScanPageView[];
  queue: { queued: number; processing: number; errors: number };
  worker: { running: boolean; restarts: number };
}

export interface ScanSessionSummary {
  id: string;
  bookName: string;
  pageCount: number;
  pending: number;
  updatedAt: string;
  exportedAt?: string;
}
