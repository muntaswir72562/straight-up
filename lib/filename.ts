import { MAX_FILENAME_LENGTH, FALLBACK_FILENAME } from './constants';

/**
 * Sanitize a user-entered book name into a safe filename stem.
 * Does NOT append .pdf -- caller does that.
 */
export function sanitizeBookName(raw: string): string {
  let name = raw.trim();
  name = name.replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '');
  name = name.replace(/\s{2,}/g, ' ').trim();
  if (name.length > MAX_FILENAME_LENGTH) {
    name = name.slice(0, MAX_FILENAME_LENGTH).trim();
  }
  return name || FALLBACK_FILENAME;
}
