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

/* --- Page Cleaning constants --- */
export const CLEAN_BLUR_SIZE = 3;
export const CLEAN_BG_KERNEL_SIZE = 51;
export const CLEAN_OPEN_KERNEL_SIZE = 3;
export const CLEAN_ADAPTIVE_BLOCK = 31;
export const CLEAN_ADAPTIVE_C = 10;

/* --- Dewarping constants --- */
export const DEWARP_DETECT_WIDTH = 1000;
export const DEWARP_MIN_LINE_WIDTH_RATIO = 0.12;
export const DEWARP_MIN_LINES = 4;
export const DEWARP_DILATION_H = 50;
export const DEWARP_DILATION_V = 3;
export const DEWARP_POLY_DEGREE = 2;
export const DEWARP_MIN_CURVATURE = 1.5;
export const DEWARP_MAX_FIT_RESIDUAL = 5.0;
export const DEWARP_MARGIN_FRACTION = 0.03;
export const DEWARP_FIELD_SIGMA_X = 30;
export const DEWARP_FIELD_SIGMA_Y = 15;

/** Render DPI for clean pipeline (binary output is less resolution-sensitive) */
export const CLEAN_RENDER_DPI = 150;

/** Default fallback filename for clean-only mode */
export const FALLBACK_CLEAN_FILENAME = 'cleaned';

