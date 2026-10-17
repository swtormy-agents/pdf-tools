export const LIMITS = Object.freeze({
  /** Max bytes of one input file (PDF or image). */
  MAX_FILE_BYTES: 100 * 1024 * 1024,
  /** Max bytes of all inputs of one call together. */
  MAX_TOTAL_BYTES: 300 * 1024 * 1024,
  /** Max pages of one input document and of the result (all outputs of split together). */
  MAX_PAGES: 1000,
  /** Max input files of one call. */
  MAX_FILES: 50,
  /** Max width*height of one image, read from its header before decoding. */
  MAX_IMAGE_PIXELS: 50_000_000,
});
