import {
  PDFDocument,
  EncryptedPDFError,
  degrees,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  drawObject,
} from 'pdf-lib';
import { PdfToolError, fail } from './errors.js';
import { LIMITS } from './limits.js';
import { parsePageRanges } from './ranges.js';
import { sanitizeSourcePage } from './sanitize.js';
import { jpegSize, pngSize, stripJpeg, stripPng, jpegOrientation } from './images.js';

// PDF user space limit (Acrobat): 14400 pt = 200 in.
const MAX_PAGE_PT = 14400;

function assertBytes(bytes, what = 'input') {
  if (!(bytes instanceof Uint8Array)) fail('PDF_INVALID', `${what} must be a Uint8Array`);
  if (bytes.length > LIMITS.MAX_FILE_BYTES) {
    fail('TOO_LARGE', `File is larger than ${LIMITS.MAX_FILE_BYTES} bytes`, { max: LIMITS.MAX_FILE_BYTES });
  }
}

function assertList(list, what) {
  if (!Array.isArray(list) || list.length === 0) fail('PDF_INVALID', `${what} must be a non-empty array`);
  if (list.length > LIMITS.MAX_FILES) {
    fail('TOO_MANY_FILES', `More than ${LIMITS.MAX_FILES} files`, { max: LIMITS.MAX_FILES });
  }
  let total = 0;
  list.forEach((item, idx) => {
    if (!item || typeof item !== 'object') fail('PDF_INVALID', `Item ${idx} must be an object`, { index: idx });
    assertBytes(item.bytes, `Item ${idx} bytes`);
    total += item.bytes.length;
  });
  if (total > LIMITS.MAX_TOTAL_BYTES) {
    fail('TOO_LARGE', `Files together are larger than ${LIMITS.MAX_TOTAL_BYTES} bytes`, { max: LIMITS.MAX_TOTAL_BYTES });
  }
}

function indexOfAscii(bytes, ascii) {
  const first = ascii.charCodeAt(0);
  outer: for (let i = bytes.indexOf(first); i !== -1; i = bytes.indexOf(first, i + 1)) {
    for (let k = 1; k < ascii.length; k++) if (bytes[i + k] !== ascii.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}

/**
 * Load with pdf-lib DEFAULT options (never ignoreEncryption). Encrypted -> PDF_ENCRYPTED,
 * any other parse failure -> PDF_INVALID.
 */
async function loadPdf(bytes, index) {
  const details = index === undefined ? undefined : { index };
  let doc;
  try {
    doc = await PDFDocument.load(bytes);
  } catch (e) {
    if (e instanceof EncryptedPDFError) fail('PDF_ENCRYPTED', 'PDF is encrypted or password-protected', details);
    // Parsing may fail before pdf-lib reaches its encryption check (e.g. encrypted object streams).
    if (indexOfAscii(bytes, '/Encrypt') !== -1) fail('PDF_ENCRYPTED', 'PDF is encrypted or password-protected', details);
    fail('PDF_INVALID', 'Not a valid PDF', details);
  }
  let count;
  try {
    count = doc.getPageCount();
    doc.getPages();
  } catch {
    fail('PDF_INVALID', 'PDF page tree is broken', details);
  }
  if (count < 1) fail('PDF_INVALID', 'PDF has no pages', details);
  return { doc, count };
}

/** MAX_PAGES applies to the RESULT only; input documents may be longer. */
function checkPageLimit(resultPages) {
  if (resultPages > LIMITS.MAX_PAGES) {
    fail('TOO_MANY_PAGES', `Result would have more than ${LIMITS.MAX_PAGES} pages`, { max: LIMITS.MAX_PAGES });
  }
}

/**
 * Matrix [a b c d e f] that maps the image unit square onto a page of the DISPLAY size,
 * applying EXIF orientation 1..8. w/h = stored (pre-orientation) size in points.
 */
export function orientationMatrix(o, w, h) {
  switch (o) {
    case 2: return [-w, 0, 0, h, w, 0]; // mirror horizontal
    case 3: return [-w, 0, 0, -h, w, h]; // rotate 180
    case 4: return [w, 0, 0, -h, 0, h]; // mirror vertical
    case 5: return [0, -w, -h, 0, h, w]; // transpose
    case 6: return [0, -w, h, 0, 0, w]; // rotate 90 CW
    case 7: return [0, w, h, 0, 0, 0]; // transverse
    case 8: return [0, w, -h, 0, h, 0]; // rotate 90 CCW
    default: return [w, 0, 0, h, 0, 0];
  }
}

async function createOutput() {
  // updateMetadata:false -> no Info dict, no Producer/Creator/dates. Catalog holds only
  // /Type and /Pages: no /Metadata, /Names, /AcroForm, /OpenAction, /Outlines.
  return PDFDocument.create({ updateMetadata: false });
}

async function saveOutput(doc) {
  return doc.save({ updateFieldAppearances: false, addDefaultPage: false });
}

async function copyInto(out, src, indexes) {
  const pages = src.getPages();
  const unique = [...new Set(indexes)];
  for (const i of unique) sanitizeSourcePage(pages[i]);
  const copied = await out.copyPages(src, indexes);
  return copied.map((p) => out.addPage(p));
}

function wrapUnknown(e) {
  if (e instanceof PdfToolError) return e;
  return new PdfToolError('PDF_INVALID', 'PDF could not be processed');
}

function rangeGroups(ranges, count) {
  if (typeof ranges === 'string') return parsePageRanges(ranges, count, LIMITS.MAX_PAGES);
  if (!Array.isArray(ranges) || ranges.length === 0) fail('PAGE_RANGE', 'ranges must be a string or a non-empty array of [from, to]');
  const groups = [];
  let total = 0;
  for (const r of ranges) {
    if (!Array.isArray(r) || r.length !== 2 || !Number.isInteger(r[0]) || !Number.isInteger(r[1])) {
      fail('PAGE_RANGE', 'each range must be [from, to] with integer 1-based pages');
    }
    const [from, to] = r;
    if (from < 1 || to < 1 || from > count || to > count) fail('PAGE_RANGE', `Page out of range 1-${count}`, { from, to, pageCount: count });
    if (from > to) fail('PAGE_RANGE', `Reversed page range ${from}-${to}`, { from, to });
    total += to - from + 1;
    checkPageLimit(total);
    const g = [];
    for (let p = from; p <= to; p++) g.push(p - 1);
    groups.push(g);
  }
  return groups;
}

/** Offending value for error details: only plain numbers, never arbitrary caller data. */
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function normalizePageSelection(pages, count, index) {
  if (pages === undefined || pages === null) return [...Array(count).keys()];
  if (typeof pages === 'string') {
    try {
      return parsePageRanges(pages, count).flat();
    } catch (e) {
      if (e instanceof PdfToolError) e.details = { index, ...(e.details || {}), pageCount: count };
      throw e;
    }
  }
  if (Array.isArray(pages)) {
    if (pages.length === 0) fail('PAGE_RANGE', 'Empty page selection', { index, pageCount: count });
    pages.forEach((p, position) => {
      if (!Number.isInteger(p) || p < 0 || p >= count) {
        fail('PAGE_RANGE', `Page index out of range 0-${count - 1}`, { index, position, page: numOrNull(p), pageCount: count });
      }
    });
    return pages.slice();
  }
  fail('PAGE_RANGE', 'pages must be a range string or an array of 0-based indexes', { index, pageCount: count });
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<{pages: number}>}
 * @throws PdfToolError PDF_ENCRYPTED for encrypted/password-protected files, PDF_INVALID, TOO_LARGE
 */
export async function pdfInfo(bytes) {
  assertBytes(bytes);
  try {
    const { count } = await loadPdf(bytes);
    return { pages: count };
  } catch (e) {
    throw wrapUnknown(e);
  }
}

/**
 * Merge documents in list order.
 * @param {{bytes: Uint8Array, pages?: string|number[]}[]} list pages: 1-based range string
 *   ('1-3,5') or array of 0-based indexes; omitted = all pages.
 * @returns {Promise<Uint8Array>}
 */
export async function merge(list) {
  assertList(list, 'merge input');
  try {
    const out = await createOutput();
    let total = 0;
    for (let idx = 0; idx < list.length; idx++) {
      const { doc, count } = await loadPdf(list[idx].bytes, idx);
      const sel = normalizePageSelection(list[idx].pages, count, idx);
      total += sel.length;
      checkPageLimit(total);
      await copyInto(out, doc, sel);
    }
    return await saveOutput(out);
  } catch (e) {
    throw wrapUnknown(e);
  }
}

/**
 * Split into one document per range group:
 *   split(b, '1-3,5') -> [{pages: [1, 2, 3], bytes}, {pages: [5], bytes}]
 * @param {Uint8Array} bytes
 * @param {string | Array<[number, number]>} ranges 1-based: a spec string (see
 *   parsePageRanges) or an array of inclusive [from, to] pairs, one output per pair
 * @returns {Promise<{pages: number[], bytes: Uint8Array}[]>} pages are 1-based source pages
 */
export async function split(bytes, ranges) {
  assertBytes(bytes);
  try {
    const { doc, count } = await loadPdf(bytes);
    // MAX_PAGES applies to the result: all output documents together.
    const groups = rangeGroups(ranges, count);
    const results = [];
    for (const g of groups) {
      const out = await createOutput();
      await copyInto(out, doc, g);
      results.push({ pages: g.map((i) => i + 1), bytes: await saveOutput(out) });
    }
    return results;
  } catch (e) {
    throw wrapUnknown(e);
  }
}

/**
 * Reorder, rotate and delete pages. All indexes are 0-based ORIGINAL page indexes.
 * @param {Uint8Array} bytes
 * @param {{order: number[], rotate?: Record<number, number>}} ops
 *   order: the final page sequence; pages absent from order are deleted; a page may be
 *   repeated (each copy counts against MAX_PAGES); empty order -> PAGE_RANGE.
 *   rotate: original index -> degrees (multiple of 90, negatives allowed), added to the
 *   page's current rotation and normalized mod 360; applies to every copy of that page.
 * @returns {Promise<Uint8Array>}
 */
export async function organize(bytes, ops) {
  assertBytes(bytes);
  if (!ops || typeof ops !== 'object') fail('PAGE_RANGE', 'ops must be an object with order');
  try {
    const { doc, count } = await loadPdf(bytes);
    const isIdx = (i) => Number.isInteger(i) && i >= 0 && i < count;

    if (!Array.isArray(ops.order) || ops.order.length === 0) fail('PAGE_RANGE', 'order must be a non-empty array', { pageCount: count });
    checkPageLimit(ops.order.length);
    ops.order.forEach((i, index) => {
      if (!isIdx(i)) fail('PAGE_RANGE', `order index out of range 0-${count - 1}`, { index, page: numOrNull(i), pageCount: count });
    });
    const final = ops.order.slice();

    const rot = new Map();
    if (ops.rotate !== undefined) {
      if (!ops.rotate || typeof ops.rotate !== 'object' || Array.isArray(ops.rotate)) fail('PAGE_RANGE', 'rotate must be an object', { pageCount: count });
      for (const [k, deg] of Object.entries(ops.rotate)) {
        const i = Number(k);
        const page = /^\d+$/.test(k) ? i : null;
        if (page === null || !isIdx(i)) fail('PAGE_RANGE', `rotate index out of range 0-${count - 1}`, { page, pageCount: count });
        if (!Number.isInteger(deg) || deg % 90 !== 0) fail('PAGE_RANGE', 'rotation must be a multiple of 90', { page, degrees: numOrNull(deg), pageCount: count });
        rot.set(i, deg);
      }
    }

    const out = await createOutput();
    const added = await copyInto(out, doc, final);
    final.forEach((orig, k) => {
      const d = rot.get(orig);
      if (!d) return;
      const page = added[k];
      const cur = page.getRotation().angle;
      page.setRotation(degrees((((cur + d) % 360) + 360) % 360));
    });
    return await saveOutput(out);
  } catch (e) {
    throw wrapUnknown(e);
  }
}

/** Fixed page sizes in points, portrait [width, height]. */
export const PAGE_SIZES = Object.freeze({
  A4: Object.freeze([595.28, 841.89]),
  Letter: Object.freeze([612, 792]),
});

function imageOptions(options) {
  if (options === undefined || options === null) return { pageSize: 'fit', margin: 0 };
  if (typeof options !== 'object' || Array.isArray(options)) fail('PDF_INVALID', 'options must be an object');
  const pageSize = options.pageSize === undefined ? 'fit' : options.pageSize;
  if (pageSize !== 'fit' && !Object.hasOwn(PAGE_SIZES, pageSize)) {
    fail('PDF_INVALID', "pageSize must be 'fit', 'A4' or 'Letter'", { option: 'pageSize' });
  }
  const margin = options.margin === undefined ? 0 : options.margin;
  const maxMargin = pageSize === 'fit' ? MAX_PAGE_PT / 4 : Math.min(...PAGE_SIZES[pageSize]) / 2;
  if (typeof margin !== 'number' || !Number.isFinite(margin) || margin < 0 || margin >= maxMargin) {
    fail('PDF_INVALID', `margin must be a number of points, 0 <= margin < ${maxMargin}`, { option: 'margin', max: maxMargin });
  }
  return { pageSize, margin };
}

function detectImage(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png';
  return undefined;
}

function withIndex(e, idx) {
  if (e instanceof PdfToolError) {
    e.details = { ...(e.details || {}), index: idx };
    return e;
  }
  return new PdfToolError('IMAGE_INVALID', `Item ${idx}: image could not be read`, { index: idx });
}

/**
 * One page per image, in list order. Format is detected from magic bytes (JPEG FF D8 FF,
 * PNG signature); any `type` field is ignored. Page size = image size, 1 px = 1 pt, after
 * EXIF orientation is applied (pages are scaled down only if a side exceeds 14400 pt, the
 * PDF implementation limit). Pixel dimensions are read from the JPEG SOF / PNG IHDR
 * header and checked against MAX_IMAGE_PIXELS before anything is decoded or embedded.
 * JPEG: APP1 (EXIF/GPS, XMP), APP13, COM, non-ICC APP2, other vendor APPn and data after
 * EOI are removed without re-encoding; APP0, APP2 ICC_PROFILE and APP14 Adobe are kept.
 * PNG: only IHDR/PLTE/tRNS/IDAT/IEND are passed on (pdf-lib then decodes and re-encodes).
 *
 * Options (all optional; defaults keep the behaviour above):
 *   pageSize: 'fit' (default, page = image size) | 'A4' (595.28 x 841.89 pt) |
 *     'Letter' (612 x 792 pt). Fixed sizes are portrait; the image (after EXIF orientation)
 *     is scaled up or down to fit inside the margins, aspect ratio preserved, centered.
 *   margin: points on every side, default 0. With 'fit' the page grows by 2 * margin.
 * @param {{bytes: Uint8Array}[]} list
 * @param {{pageSize?: 'fit'|'A4'|'Letter', margin?: number}} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function imagesToPdf(list, options) {
  assertList(list, 'images');
  const { pageSize, margin } = imageOptions(options);
  const prepared = list.map((item, idx) => {
    const kind = detectImage(item.bytes);
    if (!kind) fail('UNSUPPORTED_IMAGE', `Item ${idx}: only JPEG and PNG are supported`, { index: idx });
    let size;
    try {
      size = kind === 'jpeg' ? jpegSize(item.bytes) : pngSize(item.bytes);
    } catch (e) {
      throw withIndex(e, idx);
    }
    if (size.width * size.height > LIMITS.MAX_IMAGE_PIXELS) {
      fail('IMAGE_TOO_LARGE', `Item ${idx}: image has more than ${LIMITS.MAX_IMAGE_PIXELS} pixels`, { index: idx, max: LIMITS.MAX_IMAGE_PIXELS, ...size });
    }
    // Orientation is read BEFORE stripping APP1 (EXIF).
    const orientation = kind === 'jpeg' ? jpegOrientation(item.bytes) : 1;
    return { bytes: item.bytes, kind, size, orientation };
  });

  const out = await createOutput();
  for (let idx = 0; idx < prepared.length; idx++) {
    const { bytes, kind, size, orientation } = prepared[idx];
    let img;
    try {
      img = kind === 'jpeg' ? await out.embedJpg(stripJpeg(bytes)) : await out.embedPng(stripPng(bytes));
    } catch (e) {
      throw withIndex(e, idx);
    }
    const swap = orientation >= 5;
    // Display (post-orientation) size in pixels = points at scale 1.
    const dw = swap ? size.height : size.width;
    const dh = swap ? size.width : size.height;
    let pageW;
    let pageH;
    let scale;
    if (pageSize === 'fit') {
      const room = MAX_PAGE_PT - 2 * margin;
      scale = Math.min(1, room / dw, room / dh);
      pageW = dw * scale + 2 * margin;
      pageH = dh * scale + 2 * margin;
    } else {
      [pageW, pageH] = PAGE_SIZES[pageSize];
      scale = Math.min((pageW - 2 * margin) / dw, (pageH - 2 * margin) / dh);
    }
    const w = size.width * scale;
    const h = size.height * scale;
    const x = (pageW - dw * scale) / 2;
    const y = (pageH - dh * scale) / 2;
    const page = out.addPage([pageW, pageH]);
    const name = page.node.newXObject('Image', img.ref);
    page.pushOperators(
      pushGraphicsState(),
      ...(x !== 0 || y !== 0 ? [concatTransformationMatrix(1, 0, 0, 1, x, y)] : []),
      concatTransformationMatrix(...orientationMatrix(orientation, w, h)),
      drawObject(name),
      popGraphicsState(),
    );
  }
  try {
    return await saveOutput(out);
  } catch {
    fail('IMAGE_INVALID', 'Images could not be written to PDF');
  }
}
