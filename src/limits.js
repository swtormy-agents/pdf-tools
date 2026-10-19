export const LIMITS = Object.freeze({
  /** Max bytes of one input file (PDF or image). */
  MAX_FILE_BYTES: 100 * 1024 * 1024,
  /** Max bytes of all inputs of one call together. */
  MAX_TOTAL_BYTES: 300 * 1024 * 1024,
  /**
   * Max pages of the RESULT of one call: merge and organize output (duplicates counted),
   * EACH output part of split. Input documents may have more pages (they are bounded by
   * MAX_FILE_BYTES).
   */
  MAX_PAGES: 1000,
  /** split: max pages over all output parts together (repeats counted). */
  MAX_SPLIT_TOTAL_PAGES: 5000,
  /** split: max number of output parts. */
  MAX_SPLIT_PARTS: 50,
  /** Max input files of one call. */
  MAX_FILES: 50,
  /** Max width*height of one image, read from its header before decoding. */
  MAX_IMAGE_PIXELS: 50_000_000,
  /**
   * Max bytes decompressed from PDF streams during one call (object and xref streams while
   * parsing, filters in front of DCTDecode images while sanitizing), over all inputs.
   * Above it: TOO_LARGE with details { reason: 'decompressed', limit }.
   */
  MAX_DECOMPRESSED_BYTES: 500 * 1024 * 1024,
});
