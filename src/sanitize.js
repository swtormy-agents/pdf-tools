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

// /Subtype values that only annotations (or XMP metadata streams) carry. Any dict with one
// of these is dropped wherever it appears (page /Annots is rebuilt separately).
const DROP_SUBTYPES = new Set(['XML', 'Text', 'Link', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine',
  'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink', 'Popup', 'FileAttachment', 'Sound', 'Movie',
  'Widget', 'Screen', 'PrinterMark', 'TrapNet', 'Watermark', '3D', 'Redact', 'RichMedia', 'Projection']);

// Per-type ALLOWLISTS for dicts below /Resources (QA aea0eb0 finding 3): only keys the
// renderer needs are kept, everything else (private keys, /Ref, /OC, /F external file
// streams, ...) is removed before walking.
const STREAM_KEYS = ['Length', 'Filter', 'DecodeParms', 'DL'];
const FONT_KEYS = new Set(['Type', 'Subtype', 'BaseFont', 'Name', 'FirstChar', 'LastChar', 'Widths', 'FontDescriptor',
  'Encoding', 'ToUnicode', 'DescendantFonts', 'CIDSystemInfo', 'DW', 'W', 'DW2', 'W2', 'CIDToGIDMap', 'FontBBox',
  'FontMatrix', 'CharProcs', 'Resources']);
const FONT_DESCRIPTOR_KEYS = new Set(['Type', 'FontName', 'FontFamily', 'FontStretch', 'FontWeight', 'Flags', 'FontBBox',
  'ItalicAngle', 'Ascent', 'Descent', 'Leading', 'CapHeight', 'XHeight', 'StemV', 'StemH', 'AvgWidth', 'MaxWidth',
  'MissingWidth', 'FontFile', 'FontFile2', 'FontFile3', 'CharSet', 'Style', 'Lang', 'FD', 'CIDSet']);
const EXTGSTATE_KEYS = new Set(['Type', 'LW', 'LC', 'LJ', 'ML', 'D', 'RI', 'OP', 'op', 'OPM', 'Font', 'BG', 'BG2', 'UCR',
  'UCR2', 'TR', 'TR2', 'HT', 'HTO', 'FL', 'SM', 'SA', 'BM', 'SMask', 'CA', 'ca', 'AIS', 'TK', 'UseBlackPtComp']);
const SMASK_KEYS = new Set(['Type', 'S', 'G', 'BC', 'TR']);
const GROUP_KEYS = new Set(['Type', 'S', 'CS', 'I', 'K']);
const IMAGE_KEYS = new Set(['Type', 'Subtype', 'Width', 'Height', 'ColorSpace', 'BitsPerComponent', 'Intent', 'ImageMask',
  'Mask', 'Decode', 'Interpolate', 'SMask', 'SMaskInData', 'Matte', ...STREAM_KEYS]);
const ICC_KEYS = new Set(['N', 'Alternate', 'Range', ...STREAM_KEYS]);
const CAL_KEYS = new Set(['WhitePoint', 'BlackPoint', 'Gamma', 'Matrix', 'Range']);
const DEVICEN_ATTR_KEYS = new Set(['Subtype', 'Colorants', 'Process', 'MixingHints']);
const PATTERN_KEYS = new Set(['Type', 'PatternType', 'PaintType', 'TilingType', 'BBox', 'XStep', 'YStep', 'Resources',
  'Matrix', 'Shading', 'ExtGState', ...STREAM_KEYS]);
const SHADING_KEYS = new Set(['ShadingType', 'ColorSpace', 'Background', 'BBox', 'AntiAlias', 'Coords', 'Domain', 'Function',
  'Extend', 'Matrix', 'BitsPerCoordinate', 'BitsPerComponent', 'BitsPerFlag', 'Decode', 'VerticesPerRow', ...STREAM_KEYS]);
const FUNCTION_KEYS = new Set(['FunctionType', 'Domain', 'Range', 'Size', 'BitsPerSample', 'Order', 'Encode', 'Decode',
  'C0', 'C1', 'N', 'Functions', 'Bounds', ...STREAM_KEYS]);
const FORM_KEYS = new Set(['Type', 'Subtype', 'FormType', 'BBox', 'Matrix', 'Resources', 'Group', ...STREAM_KEYS]);

const SAFE_URI_SCHEMES = /^(https?:|mailto:)/i;

function lookupDict(ctx, obj) {
  try {
    const v = ctx.lookup(obj);
    return v instanceof PDFDict ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve a (chain of) indirect reference(s); undefined on failure or > 32 hops. */
function safeLookup(ctx, v) {
  let cur = v;
  for (let k = 0; k < 32 && cur instanceof PDFRef; k++) {
    try { cur = ctx.lookup(cur); } catch { return undefined; }
  }
  return cur instanceof PDFRef ? undefined : cur;
}

/** Read dict key `k`, resolving indirect references. Use this for EVERY value compared. */
function resolve(ctx, d, k) {
  return d ? safeLookup(ctx, d.get(PDFName.of(k))) : undefined;
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
  if (resolve(ctx, a, 'Subtype') !== PDFName.of('Link')) return undefined;
  if (a.has(PDFName.of('AA')) || a.has(PDFName.of('Dest'))) return undefined;
  const action = lookupDict(ctx, a.get(PDFName.of('A')));
  if (!action) return undefined;
  if (resolve(ctx, action, 'S') !== PDFName.of('URI')) return undefined;
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
function isDangerous(ctx, o) {
  const d = dictOf(o);
  if (!d) return false;
  const type = nameOf(resolve(ctx, d, 'Type'));
  if (type && DROP_TYPES.has(type)) return true;
  const s = nameOf(resolve(ctx, d, 'S'));
  if (s && ACTION_TYPES.has(s)) return true;
  const st = nameOf(resolve(ctx, d, 'Subtype'));
  if (st && DROP_SUBTYPES.has(st)) return true;
  if (d.has(PDFName.of('EF')) || d.has(PDFName.of('JS'))) return true;
  return false;
}

function filterNames(ctx, d) {
  const f = resolve(ctx, d, 'Filter');
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
  // Any stream with DCTDecode anywhere is treated as a JPEG, whatever its /Subtype
  // (missing, indirect, or not /Image): it is cleaned or the call fails closed.
  if (dct !== filters.length - 1 || !filters.slice(0, -1).every((f) => JPEG_PREFILTERS.has(f))) {
    fail('PDF_INVALID', 'Unsupported filter chain on JPEG image', { reason: 'image' });
  }
  let bytes = stream.contents;
  let dctParms;
  if (filters.length > 1) {
    const parms = resolve(ctx, d, 'DecodeParms');
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
    const parms = resolve(ctx, d, 'DecodeParms');
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

/** Which per-type allowlist applies to `obj` (reached with `role`), or undefined. */
function allowlistFor(ctx, obj, role) {
  const d = dictOf(obj);
  const type = nameOf(resolve(ctx, d, 'Type'));
  const sub = nameOf(resolve(ctx, d, 'Subtype'));
  if (role === 'font' || type === 'Font') return FONT_KEYS;
  if (type === 'FontDescriptor' || role === 'fontdescriptor') return FONT_DESCRIPTOR_KEYS;
  if (role === 'extgstate' || type === 'ExtGState') return EXTGSTATE_KEYS;
  if (role === 'smask' || type === 'Mask') return SMASK_KEYS;
  if (role === 'group' || type === 'Group') return GROUP_KEYS;
  if (obj instanceof PDFStream && sub === 'Form') return FORM_KEYS;
  if (obj instanceof PDFStream && sub === 'Image') return IMAGE_KEYS;
  if (d.has(PDFName.of('PatternType'))) return PATTERN_KEYS;
  if (d.has(PDFName.of('ShadingType'))) return SHADING_KEYS;
  if (d.has(PDFName.of('FunctionType'))) return FUNCTION_KEYS;
  if (role === 'cselem') {
    if (obj instanceof PDFStream && d.has(PDFName.of('N'))) return ICC_KEYS;
    if (d.has(PDFName.of('WhitePoint'))) return CAL_KEYS;
    if (d.has(PDFName.of('Colorants')) || d.has(PDFName.of('Process')) || d.has(PDFName.of('MixingHints'))) return DEVICEN_ATTR_KEYS;
  }
  return undefined;
}

/** Role of the child reached via `key` from a parent with `role` / allowlist `list`. */
function childRole(k, role, list) {
  if (role === 'resources') {
    if (k === 'Font') return 'fontmap';
    if (k === 'ExtGState') return 'gsmap';
    if (k === 'ColorSpace') return 'csmap';
    return undefined;
  }
  if (role === 'fontmap') return 'font';
  if (role === 'gsmap') return 'extgstate';
  if (role === 'csmap') return 'cs';
  if (k === 'ColorSpace' || k === 'CS' || k === 'Alternate') return 'cs';
  if (list === DEVICEN_ATTR_KEYS && k === 'Colorants') return 'csmap';
  if (k === 'Resources') return 'resources';
  if (k === 'Group') return 'group';
  if (list === EXTGSTATE_KEYS && k === 'SMask') return 'smask';
  if (list === FONT_KEYS && k === 'FontDescriptor') return 'fontdescriptor';
  if (list === FONT_KEYS && k === 'DescendantFonts') return 'fontarray';
  return undefined;
}

/**
 * Walk everything reachable from `root` (iteratively: no recursion depth issues), in place:
 *  - every /Resources dict is reduced to RESOURCE_KEYS;
 *  - Image, ColorSpace parameter (ICC, Cal/Lab, DeviceN attributes), Pattern, Shading, Function,
 *    Font, FontDescriptor, ExtGState, soft-mask, transparency-group and Form XObject dicts
 *    are reduced to their per-type allowlists;
 *  - FORBIDDEN_KEYS are deleted from every dict / stream dict;
 *  - entries and array items that are action dicts, file specs, embedded files, metadata
 *    streams, annotations or page-tree nodes are deleted (arrays: replaced by null). All
 *    names compared (/Type, /S, /Subtype, /Filter...) are resolved through indirect refs;
 *  - every stream with a DCTDecode filter is stripped of APPn/COM metadata.
 * `state.seen` is shared per source document so shared objects are processed once per role.
 */
function sanitizeGraph(ctx, root, rootRole, state) {
  const stack = [[root, rootRole]];
  while (stack.length) {
    const [item, role] = stack.pop();
    const obj = safeLookup(ctx, item);
    if (obj === undefined) continue;
    if (!(obj instanceof PDFDict || obj instanceof PDFArray || obj instanceof PDFStream)) continue;
    const rk = role || '';
    let seen = state.seen.get(rk);
    if (!seen) state.seen.set(rk, (seen = new WeakSet()));
    if (seen.has(obj)) continue;
    seen.add(obj);
    if (obj instanceof PDFArray) {
      const itemRole = role === 'fontarray' ? 'font' : role === 'cs' || role === 'cselem' ? 'cselem' : undefined;
      for (let k = 0; k < obj.size(); k++) {
        const v = obj.get(k);
        if (isDangerous(ctx, safeLookup(ctx, v))) obj.set(k, PDFNull);
        else stack.push([v, itemRole]);
      }
      continue;
    }
    const d = dictOf(obj);
    if (obj instanceof PDFRawStream) sanitizeJpegStream(ctx, obj, state.budget);
    const list = role === 'resources' ? RESOURCE_KEYS : allowlistFor(ctx, obj, role);
    for (const [key, v] of d.entries()) {
      const k = key.decodeText();
      if (list && !list.has(k)) { d.delete(key); continue; }
      if (FORBIDDEN_KEYS.has(k)) { d.delete(key); continue; }
      const target = safeLookup(ctx, v);
      if (isDangerous(ctx, target)) { d.delete(key); continue; }
      stack.push([v, childRole(k, role, list)]);
    }
  }
}

/** Per-source-document sanitizer state. */
export function newSanitizeState(budget) {
  return { budget, seen: new Map() };
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
    if (isDangerous(ctx, safeLookup(ctx, v))) { node.delete(key); continue; }
    sanitizeGraph(ctx, v, k === 'Resources' ? 'resources' : k === 'Group' ? 'group' : undefined, state);
  }
  if (kept.length) node.set(annotsKey, ctx.obj(kept));
}
