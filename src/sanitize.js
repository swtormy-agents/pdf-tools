import { PDFArray, PDFDict, PDFName, PDFNumber, PDFString, PDFHexString } from 'pdf-lib';

// Page keys that can carry actions, metadata or references back into the source document.
const PAGE_KEYS_TO_DROP = ['AA', 'Metadata', 'PieceInfo', 'B', 'StructParents', 'Thumb', 'ID', 'PZ', 'SeparationInfo'];

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

/**
 * Sanitize a page of a freshly loaded source document in place, BEFORE copyPages.
 * Doing it before copying means dropped objects are never reachable from the output
 * document, so pdf-lib does not copy them at all.
 * @param {import('pdf-lib').PDFPage} page
 */
export function sanitizeSourcePage(page) {
  const node = page.node;
  const ctx = node.context;
  for (const k of PAGE_KEYS_TO_DROP) node.delete(PDFName.of(k));
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
  if (kept.length) node.set(annotsKey, ctx.obj(kept));
  else node.delete(annotsKey);
}
