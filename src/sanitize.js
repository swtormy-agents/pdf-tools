import { PDFArray, PDFDict, PDFName, PDFNumber, PDFString, PDFHexString, PDFRef, PDFRawStream, PDFStream, PDFNull } from 'pdf-lib';
import { PdfToolError, fail } from './errors.js';
import { stripJpeg } from './images.js';
import { boundedDecode } from './decode.js';

// ALLOWLIST of page keys kept on every output page. Everything else (/AA, /Metadata,
// /PieceInfo, /AF, /Thumb, /B, /StructParents, /ID, /PZ, /SeparationInfo, private keys...)
// is removed. /Parent is needed while the source tree is traversed; copyPages drops it.
const PAGE_KEYS = new Set(['Type', 'Parent', 'Resources', 'MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox',
  'Contents', 'Rotate', 'Annots', 'UserUnit', 'Group']);
// Inherited from /Pages nodes (pdf-lib PDFPageLeaf.InheritableEntries); materialized on the
// page before sanitizing so nothing unsanitized is pulled in from a parent node.
const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];

// ALLOWLIST of resource categories, applied to EVERY /Resources dict reachable from a page
// (page, Form XObjects, tiling Patterns, Type3 fonts, soft-mask groups). /Properties is
// dropped too: it only feeds marked content / optional content, which has no effect
// without the catalog /OCProperties and /StructTreeRoot that are never copied, and it was
// a carrier for action dicts (QA 331a28a, page-privkeys).
const RESOURCE_KEYS = new Set(['Font', 'XObject', 'ExtGState', 'ColorSpace', 'Pattern', 'Shading', 'ProcSet']);

// Keys removed from EVERY dict and stream dict reachable from a kept page key.
const FORBIDDEN_KEYS = new Set(['AA', 'A', 'JS', 'JavaScript', 'Launch', 'OpenAction', 'Next', 'URI', 'AF', 'EF',
  'EmbeddedFile', 'EmbeddedFiles', 'FileAttachment', 'Metadata', 'PieceInfo', 'Thumb', 'OPI', 'Names', 'AcroForm',
  'XFA', 'StructParent', 'StructParents', 'Annots', 'Popup', 'RichMediaContent', 'Dest', 'SubmitForm', 'ImportData']);

// /S values of action dicts. A dict with one of these (or /Type /Action) is dropped
// wherever it appears. Not listed on purpose: /Luminosity, /Alpha (soft masks) and
// /Transparency (groups), which legitimately carry /S.
const ACTION_TYPES = new Set(['GoTo', 'GoToR', 'GoToE', 'GoToDp', 'Launch', 'Thread', 'URI', 'Sound', 'Movie', 'Hide',
  'Named', 'SubmitForm', 'ResetForm', 'ImportData', 'JavaScript', 'SetOCGState', 'Rendition', 'Trans', 'GoTo3DView',
  'RichMediaExecute', 'ECMAScript']);
const DROP_TYPES = new Set(['Action', 'Filespec', 'EmbeddedFile', 'Metadata', 'Annot', 'Catalog', 'Pages', 'Page',
  'Outlines', 'Sig', 'XRef', 'ObjStm']);

const SAFE_URI_SCHEMES = /^(https?:|mailto:)/i;

function lookupDict(ctx, obj) {
  try {
    const v = ctx.lookup(obj);
    return v instanceof PDFDict ? v : undefined;
  } catch {
    return undefined;
  }
}

function numbers(ctx, obj, len) {
  let arr;
  try { arr = ctx.lookup(obj); } catch { return undefined; }
  if (!(arr instanceof PDFArray) || arr.size() !== len) return undefined;
  const out = [];
  for (let k = 0; k < len; k++) {
    let v;
    try { v = ctx.lookup(arr.get(k)); } catch { return undefined; }
    if (!(v instanceof PDFNumber) || !Number.isFinite(v.asNumber())) return undefined;
    out.push(v.asNumber());
  }
  return out;
}

function uriText(ctx, obj) {
  let v;
  try { v = ctx.lookup(obj); } catch { return undefined; }
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
  return undefined;
}

/**
 * Turn an annotation into a fresh, minimal Link annotation dict, or undefined to drop it.
 * Only Link annotations whose single action is a URI action with an http(s)/mailto URI
 * survive. Everything else is dropped: Widgets (form fields), any /AA, JavaScript, Launch,
 * SubmitForm, ImportData, GoToR, GoToE, chained /Next actions, internal /Dest links (they
 * would pull the source page tree into the output), markup annotations (author names,
 * popups) and file attachments.
 */
function safeLink(ctx, annotObj) {
  const a = lookupDict(ctx, annotObj);
  if (!a) return undefined;
  const subtype = a.get(PDFName.of('Subtype'));
  if (subtype !== PDFName.of('Link')) return undefined;
  if (a.has(PDFName.of('AA')) || a.has(PDFName.of('Dest'))) return undefined;
  const action = lookupDict(ctx, a.get(PDFName.of('A')));
  if (!action) return undefined;
  if (action.get(PDFName.of('S')) !== PDFName.of('URI')) return undefined;
  if (action.has(PDFName.of('Next'))) return undefined;
  const uri = uriText(ctx, action.get(PDFName.of('URI')));
  if (!uri || !SAFE_URI_SCHEMES.test(uri.trim())) return undefined;
  const rect = numbers(ctx, a.get(PDFName.of('Rect')), 4);
  if (!rect) return undefined;
  const border = numbers(ctx, a.get(PDFName.of('Border')), 3) || [0, 0, 0];
  return ctx.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: rect,
    Border: border,
    A: { S: 'URI', URI: PDFString.of(uri.trim()) },
  });
}

function nameOf(v) {
  return v instanceof PDFName ? v.decodeText() : undefined;
}

function dictOf(o) {
  if (o instanceof PDFDict) return o;
  if (o instanceof PDFStream) return o.dict;
  return undefined;
}

/** True for objects that must never be reachable from an output page. */
function isDangerous(o) {
  const d = dictOf(o);
  if (!d) return false;
  const type = nameOf(d.get(PDFName.of('Type')));
  if (type && DROP_TYPES.has(type)) return true;
  const s = nameOf(d.get(PDFName.of('S')));
  if (s && ACTION_TYPES.has(s)) return true;
  if (d.has(PDFName.of('EF')) || d.has(PDFName.of('JS'))) return true;
  return false;
}

function safeLookup(ctx, v) {
  let cur = v;
  for (let k = 0; k < 32 && cur instanceof PDFRef; k++) {
    try { cur = ctx.lookup(cur); } catch { return undefined; }
  }
  return cur instanceof PDFRef ? undefined : cur;
}

function filterNames(ctx, d) {
  const f = safeLookup(ctx, d.get(PDFName.of('Filter')));
  if (f === undefined) return [];
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) {
    const out = [];
    for (let k = 0; k < f.size(); k++) {
      const n = safeLookup(ctx, f.get(k));
      if (!(n instanceof PDFName)) fail('PDF_INVALID', 'Invalid stream filter');
      out.push(n.decodeText());
    }
    return out;
  }
  fail('PDF_INVALID', 'Invalid stream filter');
}

const JPEG_PREFILTERS = new Set(['FlateDecode', 'LZWDecode', 'ASCII85Decode', 'ASCIIHexDecode', 'RunLengthDecode']);

/**
 * Strip EXIF/GPS, XMP, IPTC, COM and other APPn segments from a DCTDecode image stream
 * in place, with the same stripJpeg used by imagesToPdf (APP0, ICC APP2, Adobe APP14 and
 * all entropy-coded data unchanged, no re-encoding). Filters in front of DCTDecode
 * (Flate, LZW, ASCII85, ASCIIHex, RunLength) are decoded under the decompression budget
 * and removed, leaving a pure /DCTDecode stream. A JPEG that cannot be parsed fails
 * closed with PDF_INVALID { reason: 'image' } rather than being copied with its metadata.
 */
function sanitizeJpegStream(ctx, stream, budget) {
  const d = stream.dict;
  const filters = filterNames(ctx, d);
  const dct = filters.indexOf('DCTDecode');
  if (dct === -1) return;
  if (dct !== filters.length - 1 || !filters.slice(0, -1).every((f) => JPEG_PREFILTERS.has(f))) {
    fail('PDF_INVALID', 'Unsupported filter chain on JPEG image', { reason: 'image' });
  }
  let bytes = stream.contents;
  let dctParms;
  if (filters.length > 1) {
    const parms = safeLookup(ctx, d.get(PDFName.of('DecodeParms')));
    const pre = ctx.obj({});
    pre.set(PDFName.of('Filter'), ctx.obj(filters.slice(0, -1).map((f) => PDFName.of(f))));
    if (parms instanceof PDFArray) {
      const arr = [];
      for (let k = 0; k < filters.length - 1; k++) arr.push(k < parms.size() ? parms.get(k) : PDFNull);
      pre.set(PDFName.of('DecodeParms'), ctx.obj(arr));
      dctParms = parms.size() >= filters.length ? parms.get(filters.length - 1) : undefined;
    }
    try {
      bytes = boundedDecode(pre, bytes, budget);
    } catch (e) {
      if (e instanceof PdfToolError) throw e;
      fail('PDF_INVALID', 'JPEG image stream could not be decoded', { reason: 'image' });
    }
  } else {
    const parms = safeLookup(ctx, d.get(PDFName.of('DecodeParms')));
    dctParms = parms instanceof PDFArray ? (parms.size() ? parms.get(0) : undefined) : parms;
  }
  let stripped;
  try {
    stripped = stripJpeg(bytes);
  } catch {
    fail('PDF_INVALID', 'JPEG image in PDF could not be sanitized', { reason: 'image' });
  }
  d.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
  if (dctParms instanceof PDFDict || dctParms instanceof PDFRef) d.set(PDFName.of('DecodeParms'), dctParms);
  else d.delete(PDFName.of('DecodeParms'));
  stream.contents = stripped;
}

/**
 * Walk everything reachable from `root` (iteratively: no recursion depth issues), in place:
 *  - every /Resources dict is reduced to RESOURCE_KEYS;
 *  - FORBIDDEN_KEYS are deleted from every dict / stream dict;
 *  - entries and array items that are action dicts, file specs, embedded files, metadata
 *    streams, annotations or page-tree nodes are deleted (arrays: replaced by null);
 *  - DCTDecode image streams are stripped of APPn/COM metadata.
 * `state.seen` is shared per source document so shared resources are processed once.
 */
function sanitizeGraph(ctx, root, rootIsResources, state) {
  const stack = [[root, rootIsResources]];
  while (stack.length) {
    const [item, asResources] = stack.pop();
    const obj = safeLookup(ctx, item);
    if (obj === undefined) continue;
    const seen = asResources ? state.seenRes : state.seen;
    if (!(obj instanceof PDFDict || obj instanceof PDFArray || obj instanceof PDFStream)) continue;
    if (seen.has(obj)) continue;
    seen.add(obj);
    if (obj instanceof PDFArray) {
      for (let k = 0; k < obj.size(); k++) {
        const v = obj.get(k);
        if (isDangerous(safeLookup(ctx, v))) obj.set(k, PDFNull);
        else stack.push([v, false]);
      }
      continue;
    }
    const d = dictOf(obj);
    if (obj instanceof PDFRawStream && nameOf(d.get(PDFName.of('Subtype'))) === 'Image') {
      sanitizeJpegStream(ctx, obj, state.budget);
    }
    for (const [key, v] of d.entries()) {
      const k = key.decodeText();
      if (asResources && !RESOURCE_KEYS.has(k)) { d.delete(key); continue; }
      if (FORBIDDEN_KEYS.has(k)) { d.delete(key); continue; }
      const target = safeLookup(ctx, v);
      if (isDangerous(target)) { d.delete(key); continue; }
      stack.push([v, k === 'Resources']);
    }
  }
}

/** Per-source-document sanitizer state. */
export function newSanitizeState(budget) {
  return { budget, seen: new WeakSet(), seenRes: new WeakSet() };
}

/**
 * Sanitize a page of a freshly loaded source document in place, BEFORE copyPages.
 * Doing it before copying means dropped objects are never reachable from the output
 * document, so pdf-lib does not copy them at all.
 * @param {import('pdf-lib').PDFPage} page
 * @param {ReturnType<typeof newSanitizeState>} state
 */
export function sanitizeSourcePage(page, state) {
  const node = page.node;
  const ctx = node.context;
  for (const k of INHERITABLE) {
    const key = PDFName.of(k);
    if (!node.has(key)) {
      const v = node.getInheritableAttribute(key);
      if (v) node.set(key, v);
    }
  }
  for (const key of node.keys()) {
    if (!PAGE_KEYS.has(key.decodeText())) node.delete(key);
  }
  const annotsKey = PDFName.of('Annots');
  let annots;
  try { annots = ctx.lookup(node.get(annotsKey)); } catch { annots = undefined; }
  const kept = [];
  if (annots instanceof PDFArray) {
    for (let k = 0; k < annots.size(); k++) {
      const link = safeLink(ctx, annots.get(k));
      if (link) kept.push(ctx.register(link));
    }
  }
  node.delete(annotsKey);
  // Walk every kept key except Parent (page tree) and Annots (rebuilt below from scratch).
  for (const [key, v] of node.entries()) {
    const k = key.decodeText();
    if (k === 'Parent' || k === 'Type') continue;
    if (isDangerous(safeLookup(ctx, v))) { node.delete(key); continue; }
    sanitizeGraph(ctx, v, k === 'Resources', state);
  }
  if (kept.length) node.set(annotsKey, ctx.obj(kept));
}
