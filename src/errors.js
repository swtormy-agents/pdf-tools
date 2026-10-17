/** Error codes are part of the public contract. Do not rename. */
export const ERROR_CODES = Object.freeze([
  'PDF_ENCRYPTED',
  'PDF_INVALID',
  'PAGE_RANGE',
  'TOO_LARGE',
  'TOO_MANY_PAGES',
  'TOO_MANY_FILES',
  'IMAGE_TOO_LARGE',
  'UNSUPPORTED_IMAGE',
  'IMAGE_INVALID',
]);

export class PdfToolError extends Error {
  /**
   * @param {string} code one of ERROR_CODES
   * @param {string} message human-readable English message (no user data)
   * @param {object} [details] small, non-sensitive details (indexes, limits)
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'PdfToolError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function fail(code, message, details) {
  throw new PdfToolError(code, message, details);
}
