// Types for @local-pdf-tools/core/fixtures (Node only: uses node:zlib).
export declare const EVIL_MARKER: string;
export declare const SAFE_LINK_URI: string;
export declare const KEEP_ICC_MARKER: string;
export declare const KEEP_ADOBE_MARKER: string;
export declare function plainPdf(n?: number): Promise<Uint8Array>;
export declare function evilPdf(): Promise<Uint8Array>;
export declare function encryptedPdf(): Uint8Array;
export declare function corruptBytes(n?: number, seed?: number): Uint8Array;
export declare function truncatedPdf(): Uint8Array;
/** Valid 1-page PDF plus an unreferenced /ObjStm with garbage FlateDecode data. */
export declare function brokenFlatePdf(seed?: number): Uint8Array;
export declare function plainJpeg(): Uint8Array;
export declare function exifPayload(opts?: { orientation?: number; littleEndian?: boolean; gps?: boolean; gpsRationals?: number[] }): Uint8Array;
export declare function exifGpsPayload(): Uint8Array;
/** Default synthetic, non-zero GPS rationals (lat d,m,s then lon d,m,s; numerator, denominator). */
export declare const GPS_RATIONALS: readonly number[];
export declare function gpsRationalBytes(littleEndian?: boolean, values?: number[]): Uint8Array;
export declare function exifJpeg(opts?: { orientation?: number; littleEndian?: boolean; gpsRationals?: number[] }): Uint8Array;
export declare function orientedJpeg(orientation: number, littleEndian?: boolean): Uint8Array;
export declare function iccAdobeJpeg(): Uint8Array;
export declare function jpegWithSize(width: number, height: number): Uint8Array;
export declare function pngChunk(type: string, data: string | Uint8Array): Uint8Array;
export declare function plainPng(w?: number, h?: number, extraChunks?: Uint8Array[]): Uint8Array;
export declare function metadataPng(): Uint8Array;
export declare function pngWithSize(width: number, height: number): Uint8Array;
export declare function allFixtures(): Promise<Record<string, Uint8Array>>;
