// Fixture generator for @local-pdf-tools/core tests (and for consumers, e.g. the MCP server).
// Importable: import * as fx from '@local-pdf-tools/core/fixtures'. Every generator returns
// a fresh Uint8Array and is deterministic. Run directly (node test/fixtures/gen.mjs) to also
// write the files to test/fixtures/out/ for manual inspection.
// Uses pdf-lib and node:zlib (Node only; the core itself has no Node-specific code).
import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFString, PDFArray } from 'pdf-lib';

const enc = new TextEncoder();
const bytesOf = (s) => (typeof s === 'string' ? enc.encode(s) : s);

function concat(...parts) {
  const arr = parts.map(bytesOf);
  const out = new Uint8Array(arr.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of arr) { out.set(p, o); o += p.length; }
  return out;
}

/** Plain PDF with n pages; page k (1-based) is (100 + k) x 200 pt so tests can identify pages. */
export async function plainPdf(n = 3) {
  const doc = await PDFDocument.create();
  for (let k = 1; k <= n; k++) doc.addPage([100 + k, 200]);
  return doc.save({ useObjectStreams: false });
}

/** Marker strings planted in evilPdf(); none may appear in any core output. */
export const EVIL_MARKER = 'EVIL';
/** The only annotation core must keep from evilPdf(). */
export const SAFE_LINK_URI = 'https://example.com/SAFE-LINK';

/**
 * 2-page PDF with doc metadata (Info + XMP), OpenAction JS, document-level JavaScript,
 * an embedded file, an AcroForm text field (Widget), page /AA, and on page 1 annotations:
 * Link with JavaScript / Launch / SubmitForm / ImportData / GoToR / GoToE actions,
 * URI link with /AA, javascript: URI, URI with /Next JS, internal /Dest link, Text comment
 * with author, FileAttachment, plus one safe URI link (SAFE_LINK_URI). Saved without
 * object streams so markers are visible in the raw bytes.
 */
export async function evilPdf() {
  const doc = await PDFDocument.create();
  doc.setTitle('EVIL-TITLE');
  doc.setAuthor('EVIL-AUTHOR');
  doc.setSubject('EVIL-SUBJECT');
  doc.setKeywords(['EVIL-KEYWORDS']);
  doc.setProducer('EVIL-PRODUCER');
  doc.setCreator('EVIL-CREATOR');
  const ctx = doc.context;
  const p1 = doc.addPage([300, 400]);
  const p2 = doc.addPage([310, 400]);

  const xmp = ctx.stream('<x:xmpmeta xmlns:x="adobe:ns:meta/">EVIL-XMP</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(PDFName.of('Metadata'), ctx.register(xmp));
  doc.catalog.set(PDFName.of('OpenAction'), ctx.obj({ S: 'JavaScript', JS: PDFString.of('app.alert("EVIL-OPENACTION")') }));
  const docJs = ctx.register(ctx.obj({ S: 'JavaScript', JS: PDFString.of('app.alert("EVIL-DOCJS")') }));
  const ef = ctx.register(ctx.stream('EVIL-ATTACHMENT-CONTENT', { Type: 'EmbeddedFile' }));
  const filespec = ctx.register(ctx.obj({ Type: 'Filespec', F: PDFString.of('EVIL-ATTACHMENT.txt'), EF: { F: ef } }));
  doc.catalog.set(PDFName.of('Names'), ctx.obj({
    JavaScript: { Names: [PDFString.of('a'), docJs] },
    EmbeddedFiles: { Names: [PDFString.of('EVIL-ATTACHMENT.txt'), filespec] },
  }));

  const form = doc.getForm();
  const field = form.createTextField('EVIL-FIELD-NAME');
  field.setText('EVIL-FIELD-VALUE');
  field.addToPage(p1, { x: 20, y: 300, width: 200, height: 30 });

  const js = (s) => ({ S: 'JavaScript', JS: PDFString.of(s) });
  p1.node.set(PDFName.of('AA'), ctx.obj({ O: js('EVIL-PAGE-AA-OPEN'), C: js('EVIL-PAGE-AA-CLOSE') }));
  p2.node.set(PDFName.of('AA'), ctx.obj({ O: js('EVIL-PAGE2-AA') }));

  const rect = [10, 10, 60, 30];
  const link = (extra) => ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect, ...extra }));
  const annots = [
    link({ A: js('EVIL-LINK-JS') }),
    link({ A: { S: 'Launch', F: PDFString.of('EVIL-LAUNCH.exe') } }),
    link({ A: { S: 'SubmitForm', F: PDFString.of('https://evil.example/EVIL-SUBMIT') } }),
    link({ A: { S: 'ImportData', F: PDFString.of('EVIL-IMPORT.fdf') } }),
    link({ A: { S: 'GoToR', F: PDFString.of('EVIL-GOTOR.pdf'), D: [0, 'Fit'] } }),
    link({ A: { S: 'GoToE', T: { R: 'C', N: PDFString.of('EVIL-GOTOE') } } }),
    link({ A: { S: 'URI', URI: PDFString.of('https://example.com/EVIL-AA-LINK') }, AA: { E: js('EVIL-LINK-AA') } }),
    link({ A: { S: 'URI', URI: PDFString.of('javascript:EVIL_JS_URI()') } }),
    link({ A: { S: 'URI', URI: PDFString.of('https://example.com/EVIL-NEXT'), Next: js('EVIL-NEXT-JS') } }),
    link({ Dest: [p2.ref, 'Fit'], Contents: PDFString.of('EVIL-INTERNAL-DEST') }),
    ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: rect, T: PDFString.of('EVIL-COMMENT-AUTHOR'), Contents: PDFString.of('EVIL-COMMENT') })),
    ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'FileAttachment', Rect: rect, FS: filespec, Contents: PDFString.of('EVIL-FILEATTACH') })),
    ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 50, 200, 70], Border: [0, 0, 1], A: { S: 'URI', URI: PDFString.of(SAFE_LINK_URI) } })),
  ];
  const existing = p1.node.lookup(PDFName.of('Annots'), PDFArray); // holds the Widget
  for (const a of annots) existing.push(a);
  return doc.save({ useObjectStreams: false, updateFieldAppearances: true });
}

/**
 * Minimal hand-written PDF with a Standard security handler /Encrypt dict in the trailer.
 * pdf-lib cannot encrypt and no MIT tool is bundled, so the dict is static (RC4 40-bit,
 * dummy O/U); real decryption is never attempted, the core must just refuse it.
 */
export function encryptedPdf() {
  const hex32 = '0123456789abcdef'.repeat(4);
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    `<< /Filter /Standard /V 1 /R 2 /O <${hex32}> /U <${hex32}> /P -44 >>`,
  ];
  let body = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Encrypt 4 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(body, (c) => c.charCodeAt(0));
}

/** Deterministic non-PDF bytes. */
export function corruptBytes(n = 4096, seed = 42) {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out[i] = x >>> 24; }
  return out;
}

/** PDF header followed by garbage. */
export function truncatedPdf() {
  return concat('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R', corruptBytes(512, 7));
}

// --- JPEG -------------------------------------------------------------------------------
// 24x16 baseline JPEG (non-square, so orientation swaps are visible), generated for this
// repo (no third-party content).
const BASE_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAQABgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDhI9L8zb+7xitC30fp8tdTb6N0+WtO30fp8tcOKzaVSTnN3bODLs2tbU5a30fp8tFd5b6P0+WivJnmWu59xh829zc//9k=';

function b64(s) {
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Clean 24x16 JPEG (JFIF APP0 only). */
export function plainJpeg() {
  return b64(BASE_JPEG_B64);
}

function seg(marker, payload) {
  const p = bytesOf(payload);
  const len = p.length + 2;
  return concat(Uint8Array.of(0xff, marker, len >> 8, len & 0xff), p);
}

/**
 * APP1 EXIF payload ('Exif\0\0' + TIFF). IFD0 holds ImageDescription (EVIL-EXIF-DESC),
 * optional Orientation and a GPS IFD pointer; GPS IFD: N 55°45'12.34", E 37°37'4.56".
 * @param {{orientation?: number, littleEndian?: boolean, gps?: boolean}} [opts]
 */
export function exifPayload({ orientation, littleEndian = false, gps = true } = {}) {
  const le = littleEndian;
  const buf = new Uint8Array(256);
  const dv = new DataView(buf.buffer);
  buf.set(enc.encode('Exif\0\0'), 0);
  const t = 6; // TIFF start; all offsets below are relative to it
  buf.set(enc.encode(le ? 'II' : 'MM'), t);
  dv.setUint16(t + 2, 42, le);
  dv.setUint32(t + 4, 8, le);
  const desc = 'EVIL-EXIF-DESC\0';
  const entries = [[0x010e, 2, desc.length, 'desc']];
  if (orientation !== undefined) entries.push([0x0112, 3, 1, 'orient']);
  if (gps) entries.push([0x8825, 4, 1, 'gps']);
  const ifd0 = 8;
  const afterIfd0 = ifd0 + 2 + entries.length * 12 + 4;
  const descOff = afterIfd0;
  const gpsOff = descOff + desc.length + (desc.length % 2);
  dv.setUint16(t + ifd0, entries.length, le);
  entries.forEach(([tag, type, count, kind], k) => {
    const e = t + ifd0 + 2 + k * 12;
    dv.setUint16(e, tag, le); dv.setUint16(e + 2, type, le); dv.setUint32(e + 4, count, le);
    if (kind === 'desc') dv.setUint32(e + 8, descOff, le);
    if (kind === 'orient') dv.setUint16(e + 8, orientation, le);
    if (kind === 'gps') dv.setUint32(e + 8, gpsOff, le);
  });
  dv.setUint32(t + ifd0 + 2 + entries.length * 12, 0, le);
  buf.set(enc.encode(desc), t + descOff);
  let end = t + gpsOff;
  if (gps) {
    const g = t + gpsOff;
    dv.setUint16(g, 4, le);
    const ratOff = gpsOff + 2 + 4 * 12 + 4;
    const ent = (k, tag, type, count, val, inlineAscii) => {
      const e = g + 2 + k * 12;
      dv.setUint16(e, tag, le); dv.setUint16(e + 2, type, le); dv.setUint32(e + 4, count, le);
      if (inlineAscii) buf[e + 8] = inlineAscii.charCodeAt(0);
      else dv.setUint32(e + 8, val, le);
    };
    ent(0, 1, 2, 2, 0, 'N'); // GPSLatitudeRef
    ent(1, 2, 5, 3, ratOff); // GPSLatitude
    ent(2, 3, 2, 2, 0, 'E'); // GPSLongitudeRef
    ent(3, 4, 5, 3, ratOff + 24); // GPSLongitude
    dv.setUint32(g + 2 + 48, 0, le);
    const rats = [55, 1, 45, 1, 1234, 100, 37, 1, 37, 1, 456, 100];
    rats.forEach((v, k) => dv.setUint32(t + ratOff + k * 4, v, le));
    end = t + ratOff + rats.length * 4;
  }
  return buf.slice(0, end);
}

/** Back-compat alias: big-endian EXIF with GPS, no orientation. */
export const exifGpsPayload = () => exifPayload();

/** The GPS latitude rationals as stored in exifGpsPayload(); must not appear in output. */
export function gpsRationalBytes(littleEndian = false) {
  const b = new Uint8Array(24);
  const dv = new DataView(b.buffer);
  [55, 1, 45, 1, 1234, 100].forEach((v, k) => dv.setUint32(k * 4, v, littleEndian));
  return b;
}

function splitAfterApp0(base) {
  const app0Len = (base[4] << 8) | base[5];
  return [base.subarray(0, 4 + app0Len), base.subarray(4 + app0Len)]; // SOI + APP0, rest
}

/** Marker strings that MUST survive in the embedded JPEG stream (colour data). */
export const KEEP_ICC_MARKER = 'KEEP-ICC';
export const KEEP_ADOBE_MARKER = 'Adobe';

/**
 * 24x16 JPEG with APP1 EXIF (description + GPS, optional orientation), APP1 XMP, APP13
 * IPTC, APP2 MPF, COM and trailing data after EOI.
 * @param {{orientation?: number, littleEndian?: boolean}} [opts]
 */
export function exifJpeg(opts = {}) {
  const [head, rest] = splitAfterApp0(plainJpeg());
  return concat(
    head,
    seg(0xe1, exifPayload(opts)),
    seg(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>EVIL-XMP-JPEG</x:xmpmeta>'),
    seg(0xed, 'Photoshop 3.0\x008BIM EVIL-IPTC'),
    seg(0xe2, 'MPF\0EVIL-MPF'),
    seg(0xfe, 'EVIL-JPEG-COMMENT'),
    rest,
    'EVIL-AFTER-EOI',
  );
}

/** JPEG with EXIF Orientation = o (1..8) and GPS. */
export const orientedJpeg = (o, littleEndian = false) => exifJpeg({ orientation: o, littleEndian });

/**
 * JPEG with an APP2 ICC_PROFILE segment and an APP14 Adobe segment (both must be kept so
 * CMYK/wide-gamut colours are not broken) plus an APP1 EXIF that must go. The ICC payload
 * is a dummy (marker text), only used to check the segment is carried through.
 */
export function iccAdobeJpeg() {
  const [head, rest] = splitAfterApp0(plainJpeg());
  const adobe = concat('Adobe', Uint8Array.of(0, 100, 0, 0, 0, 0, 1)); // version 100, transform 1 (YCbCr)
  return concat(
    head,
    seg(0xe2, concat('ICC_PROFILE\0', Uint8Array.of(1, 1), KEEP_ICC_MARKER)),
    seg(0xee, adobe),
    seg(0xe1, exifPayload()),
    rest,
  );
}

/** plainJpeg() with its SOF0 header patched to width x height (pixels are not changed). */
export function jpegWithSize(width, height) {
  const b = plainJpeg().slice();
  for (let i = 2; i < b.length - 9; i++) {
    if (b[i] === 0xff && b[i + 1] === 0xc0) {
      b[i + 5] = height >> 8; b[i + 6] = height & 0xff;
      b[i + 7] = width >> 8; b[i + 8] = width & 0xff;
      return b;
    }
  }
  throw new Error('SOF0 not found');
}

// --- PNG --------------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function pngChunk(type, data) {
  const d = bytesOf(data);
  const out = new Uint8Array(12 + d.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, d.length);
  out.set(enc.encode(type), 4);
  out.set(d, 8);
  dv.setUint32(8 + d.length, crc32(out.subarray(4, 8 + d.length)));
  return out;
}

function ihdr(w, h) {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  d[8] = 8; d[9] = 2; // 8-bit RGB
  return pngChunk('IHDR', d);
}

const PNG_SIG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** Valid RGB PNG w x h (gradient). extraChunks are inserted between IHDR and IDAT. */
export function plainPng(w = 8, h = 8, extraChunks = []) {
  const raw = new Uint8Array(h * (1 + 3 * w));
  for (let y = 0; y < h; y++) {
    const r = y * (1 + 3 * w);
    raw[r] = 0;
    for (let x = 0; x < w; x++) {
      raw[r + 1 + 3 * x] = (x * 255) / Math.max(1, w - 1);
      raw[r + 2 + 3 * x] = (y * 255) / Math.max(1, h - 1);
      raw[r + 3 + 3 * x] = 128;
    }
  }
  return concat(PNG_SIG, ihdr(w, h), ...extraChunks, pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', new Uint8Array(0)));
}

/** 8x8 PNG with tEXt, iTXt, zTXt, eXIf and tIME chunks carrying EVIL markers. */
export function metadataPng() {
  return plainPng(8, 8, [
    pngChunk('tEXt', 'Comment\0EVIL-PNG-TEXT'),
    pngChunk('iTXt', 'Description\0\0\0\0\0EVIL-PNG-ITXT'),
    pngChunk('zTXt', concat('Comment\0\0', deflateSync(enc.encode('EVIL-PNG-ZTXT')))),
    pngChunk('eXIf', concat('MM\0*\0\0\0\x08', 'EVIL-PNG-EXIF')),
    pngChunk('tIME', Uint8Array.of(0x07, 0xea, 10, 17, 9, 0, 0)),
  ]);
}

/** PNG whose IHDR claims width x height but carries a tiny bogus IDAT (decoding would fail/explode). */
export function pngWithSize(width, height) {
  return concat(PNG_SIG, ihdr(width, height), pngChunk('IDAT', deflateSync(new Uint8Array(64))), pngChunk('IEND', new Uint8Array(0)));
}

/** All file fixtures by name (async). */
export async function allFixtures() {
  return {
    'plain-3.pdf': await plainPdf(3),
    'evil.pdf': await evilPdf(),
    'encrypted.pdf': encryptedPdf(),
    'corrupt.bin': corruptBytes(),
    'truncated.pdf': truncatedPdf(),
    'plain.jpg': plainJpeg(),
    'exif-gps.jpg': exifJpeg(),
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((o) => [`orientation-${o}.jpg`, orientedJpeg(o)])),
    'icc-adobe.jpg': iccAdobeJpeg(),
    'oversized-10000.jpg': jpegWithSize(10000, 10000),
    'plain.png': plainPng(),
    'metadata.png': metadataPng(),
    'oversized-10000.png': pngWithSize(10000, 10000),
  };
}

const isMain = typeof process !== 'undefined' && process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = new URL('./out/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(await allFixtures())) {
    writeFileSync(new URL(name, dir), bytes);
    console.log(`${name}\t${bytes.length}`);
  }
}
