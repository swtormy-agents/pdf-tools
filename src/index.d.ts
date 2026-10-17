// Type declarations for @local-pdf-tools/core (hand-written; keep in sync with src/*.js).

export type ErrorCode =
  | 'PDF_ENCRYPTED'
  | 'PDF_INVALID'
  | 'PAGE_RANGE'
  | 'TOO_LARGE'
  | 'TOO_MANY_PAGES'
  | 'TOO_MANY_FILES'
  | 'IMAGE_TOO_LARGE'
  | 'UNSUPPORTED_IMAGE'
  | 'IMAGE_INVALID';

export declare const ERROR_CODES: readonly ErrorCode[];

export declare class PdfToolError extends Error {
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>);
  readonly name: 'PdfToolError';
  code: ErrorCode;
  details?: { index?: number; max?: number; [key: string]: unknown };
}

export declare const LIMITS: Readonly<{
  MAX_FILE_BYTES: number; // 100 * 1024 * 1024
  MAX_TOTAL_BYTES: number; // 300 * 1024 * 1024
  MAX_PAGES: number; // 1000, result pages
  MAX_FILES: number; // 50
  MAX_IMAGE_PIXELS: number; // 50_000_000
}>;

export interface PdfInfo {
  pages: number;
  encrypted: false;
}

export interface MergeInput {
  bytes: Uint8Array;
  /** 1-based range string ('1-3,5') or 0-based page indexes. Omitted = all pages. */
  pages?: string | number[];
}

export type RangeSpec = string | Array<[from: number, to: number]>;

export interface SplitPart {
  /** 1-based source page numbers in this part. */
  pages: number[];
  bytes: Uint8Array;
}

export interface OrganizeOps {
  /** Final sequence of 0-based ORIGINAL page indexes; absent pages are deleted; repeats allowed. */
  order: number[];
  /** Original index -> degrees (multiple of 90, negatives allowed), added to current rotation. */
  rotate?: Record<number, number>;
}

export interface ImageInput {
  bytes: Uint8Array;
  /** Ignored: the format is detected from magic bytes. */
  type?: string;
}

export declare function pdfInfo(bytes: Uint8Array): Promise<PdfInfo>;
export declare function merge(list: MergeInput[]): Promise<Uint8Array>;
export declare function split(bytes: Uint8Array, ranges: RangeSpec): Promise<SplitPart[]>;
export declare function organize(bytes: Uint8Array, ops: OrganizeOps): Promise<Uint8Array>;
export declare function imagesToPdf(list: ImageInput[]): Promise<Uint8Array>;

/** '1-3,5' -> [[0,1,2],[4]] (0-based). Separators , ，  dashes - – ~ ～, spaces ignored. */
export declare function parsePageRanges(spec: string, pageCount: number, maxTotal?: number): number[][];

export declare function jpegSize(bytes: Uint8Array): { width: number; height: number };
export declare function pngSize(bytes: Uint8Array): { width: number; height: number };
export declare function jpegOrientation(bytes: Uint8Array): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export declare function stripJpeg(bytes: Uint8Array): Uint8Array;
export declare function stripPng(bytes: Uint8Array): Uint8Array;
export declare function orientationMatrix(orientation: number, width: number, height: number): [number, number, number, number, number, number];
