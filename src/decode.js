import { PDFName, PDFRawStream, PDFDict, PDFArray, PDFRef, decodePDFRawStream } from 'pdf-lib';
import pako from 'pako';
import { fail } from './errors.js';
import { LIMITS } from './limits.js';

/**
 * Decompression budget for one public call (merge/split/organize/pdfInfo). Every stream
 * this module decodes (object streams and xref streams while parsing, filters in front of
 * DCTDecode while sanitizing images) is charged against it. Once it is exceeded the call
 * throws TOO_LARGE { reason: 'decompressed', limit }.
 */
export function newBudget(limit = LIMITS.MAX_DECOMPRESSED_BYTES) {
  return { limit, used: 0, exceeded: false };
}

export function failDecompressed(budget) {
  fail('TOO_LARGE', `Decompressed streams exceed ${budget.limit} bytes`, { reason: 'decompressed', limit: budget.limit });
}

const MAX_EMPTY_BLOCKS = 1_000_000;
const MAX_FILTERS = 8;

function exceed(budget) {
  budget.exceeded = true;
  failDecompressed(budget);
}

/**
 * Count the bytes a zlib stream inflates to, without keeping them, aborting as soon as the
 * count passes `left`. pdf.js's FlateStream (used by pdf-lib) inflates one whole deflate
 * block per step, and a single block can expand ~1000x, so it cannot be bounded from the
 * outside; pako emits output in 64 KiB chunks whatever the block layout. Stops quietly at
 * the first data error or at the end of input: pdf-lib's own decoder then decides.
 */
function flateSize(bytes, left, budget) {
  let n = 0;
  const inf = new pako.Inflate({ chunkSize: 64 * 1024 });
  inf.onData = (chunk) => {
    n += chunk.length;
    if (n > left) exceed(budget);
  };
  inf.onEnd = () => {};
  inf.push(bytes, true);
  return n;
}

/** Decode one filter stage with pdf-lib's decoder, never past `left` bytes. */
function decodeStage(ctx, bytes, filter, parms, left, budget) {
  if (filter === 'FlateDecode' && flateSize(bytes, left, budget) > left) exceed(budget);
  const dict = ctx.obj({});
  dict.set(PDFName.of('Filter'), PDFName.of(filter));
  if (parms instanceof PDFDict) dict.set(PDFName.of('DecodeParms'), parms);
  const s = decodePDFRawStream({ dict, contents: bytes });
  // LZW, RunLength, ASCII85 and ASCIIHex produce a few KiB to ~2 MiB per readBlock.
  let empty = 0;
  while (!s.eof) {
    const before = s.bufferLength;
    s.readBlock();
    if (s.bufferLength > left) exceed(budget);
    if (s.bufferLength === before && ++empty > MAX_EMPTY_BLOCKS) fail('PDF_INVALID', 'Stream does not terminate');
  }
  return s.buffer.subarray(0, s.bufferLength);
}

/**
 * Decode the filters of a stream (pdf-lib's decoders: Flate, LZW, ASCII85, ASCIIHex,
 * RunLength) stage by stage. The output of EVERY stage is charged to the budget, so no
 * stage can grow past what is left of it.
 * @returns {Uint8Array}
 */
export function boundedDecode(dict, contents, budget) {
  if (budget.exceeded) failDecompressed(budget);
  const ctx = dict.context;
  const f = dict.lookup(PDFName.of('Filter'));
  const p = dict.lookup(PDFName.of('DecodeParms'));
  let filters;
  let parms;
  if (f === undefined) { filters = []; parms = []; }
  else if (f instanceof PDFName) { filters = [f.decodeText()]; parms = [p]; }
  else if (f instanceof PDFArray) {
    filters = [];
    parms = [];
    for (let k = 0; k < f.size(); k++) {
      const n = f.lookup(k);
      if (!(n instanceof PDFName)) fail('PDF_INVALID', 'Invalid stream filter');
      filters.push(n.decodeText());
      parms.push(p instanceof PDFArray && k < p.size() ? p.lookup(k) : undefined);
    }
  } else fail('PDF_INVALID', 'Invalid stream filter');
  if (filters.length > MAX_FILTERS) fail('PDF_INVALID', 'Too many stream filters');
  let bytes = contents;
  for (let k = 0; k < filters.length; k++) {
    bytes = decodeStage(ctx, bytes, filters[k], parms[k], budget.limit - budget.used, budget);
    budget.used += bytes.length;
  }
  if (!filters.length) {
    if (bytes.length > budget.limit - budget.used) exceed(budget);
    budget.used += bytes.length;
  }
  return bytes;
}

/**
 * pdf-lib decodes /ObjStm and /XRef streams while parsing, with no size limit. Hook the
 * parser instance so those streams are decoded here first, under the budget, and handed
 * to pdf-lib already decoded (Filter removed). pdf-lib swallows errors thrown while
 * parsing one object (it tries to recover), so the caller must check budget.exceeded.
 * @param {import('pdf-lib').PDFParser} parser
 */
export function guardParser(parser, budget) {
  const parseObject = parser.parseObject;
  parser.parseObject = function guardedParseObject(...args) {
    const obj = parseObject.apply(this, args);
    if (obj instanceof PDFRawStream) {
      // /Type may be an indirect ref (pdf-lib's parser resolves it with lookup, so a stream
      // with /Type 7 0 R -> /ObjStm IS inflated by pdf-lib). Resolve it the same way; if it
      // is a ref that cannot be resolved (yet), treat it as a parse-time stream too: it is
      // decoded here under the budget, so nothing can be inflated without being counted.
      let type = obj.dict.get(PDFName.of('Type'));
      let unresolved = false;
      if (type instanceof PDFRef) {
        try { type = obj.dict.context.lookup(type); } catch { type = undefined; }
        if (type === undefined || type instanceof PDFRef) unresolved = true;
      }
      if ((unresolved || type === PDFName.of('ObjStm') || type === PDFName.of('XRef')) && obj.dict.has(PDFName.of('Filter'))) {
        const decoded = boundedDecode(obj.dict, obj.contents, budget);
        obj.dict.delete(PDFName.of('Filter'));
        obj.dict.delete(PDFName.of('DecodeParms'));
        obj.contents = decoded;
      }
    }
    return obj;
  };
  return parser;
}
