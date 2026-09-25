/** Number of slots shown on initial load */
export const SLOTS_DEFAULT = 5;

/** Number of slots added per "Add more" click */
export const SLOTS_ADD_STEP = 5;

/** Maximum characters for a sanitized book name */
export const MAX_FILENAME_LENGTH = 150;

/** Default fallback filename when book name is empty after sanitization */
export const FALLBACK_FILENAME = 'merged-book';

/** Default fallback filename for fix-only mode */
export const FALLBACK_FIX_FILENAME = 'straightened';

/** PDF magic bytes: %PDF- */
export const PDF_MAGIC_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

/** Bytes to read for the header check */
export const PDF_HEADER_READ_SIZE = 10;

/* --- Phase 2+ constants (unused in Phase 1) --- */
export const RENDER_DPI = 200;
export const MAX_RENDER_DIMENSION = 3500;
export const DETECT_WIDTH = 1000;
export const MAX_ANGLE = 10;
export const COARSE_STEP = 0.5;
export const FINE_STEP = 0.05;
export const SKIP_THRESHOLD = 0.2;
export const MIN_CONFIDENCE = 1.5;
export const MIN_TEXT_PIXEL_RATIO = 0.01;
export const JPEG_QUALITY = 0.85;
export const AUTO_CROP = true;

/** Width in pixels for page thumbnails in Replace Pages mode */
export const THUMBNAIL_WIDTH = 180;
