// Regression suite ported from the adversarial QA review of 331a28a (246 cases, Python +
// pikepdf harness). Fixtures in test/qa/fixtures (synthetic; see README there). Large
// fixtures (2000/1001-page PDFs) are generated here; the multi-GiB object-stream bombs are
// covered by sanitize.test.mjs. Expected results follow the current contract: open ranges
// such as '-1' are valid, split limits are per part (MAX_PAGES) and over all parts
// (MAX_SPLIT_TOTAL_PAGES), decompression above MAX_DECOMPRESSED_BYTES -> TOO_LARGE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFString, PDFHexString, decodePDFRawStream } from 'pdf-lib';
import * as core from '../src/index.js';
import * as fx from './fixtures/gen.mjs';
import { deflateBombRepeated, objStmBombPdf } from './helpers.mjs';

const F = new URL('./qa/fixtures/', import.meta.url);
const rd = (n) => new Uint8Array(readFileSync(new URL(n, F)));
const MB = 1024 * 1024;

const BAD_NAMES = new Set(['JavaScript', 'JS', 'Launch', 'GoToR', 'GoToE', 'SubmitForm', 'ImportData', 'EmbeddedFile',
  'EmbeddedFiles', 'Filespec', 'EF', 'AF', 'AA', 'OpenAction', 'AcroForm', 'XFA', 'Metadata', 'PieceInfo', 'Widget',
  'FileAttachment', 'Next', 'Names', 'Thumb', 'Popup', 'RichMedia', 'Rendition', 'Sound', 'Movie', 'Hide', 'SetOCGState',
  'LeakJS', 'LeakLaunch', 'LeakRes', 'Properties', 'Dest', 'GoTo']);
const BAD_ANNOTS = new Set(['Text', 'Popup', 'FreeText', 'Ink', 'Highlight', 'Square', 'Widget', 'FileAttachment']);
const RAW_BAD = ['LEAK', 'pdf-lib', '/Producer', '/Creator', '/Author', '/ModDate', '/CreationDate', '/Info', 'EVIL',
  'javascript', 'Exif', 'GPS'];
const DECODED_BAD = ['LEAK', 'EVIL', 'javascript', 'Exif\0', 'xmpmeta'];
const OK_URI = /^(https?:|mailto:)/i;
const latin1 = (b) => Buffer.from(b.buffer, b.byteOffset, b.length).toString('latin1');

/** JPEG markers before SOS, e.g. ['E0', 'E2:ICC', 'DB', ...]. */
function jpegMarkers(b) {
  const ms = [];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const m = b[i + 1];
    if (m === 0xda) break;
    const len = (b[i + 2] << 8) | b[i + 3];
    const tag = m.toString(16).toUpperCase();
    ms.push(tag === 'E2' && latin1(b.subarray(i + 4, i + 16)).startsWith('ICC_PROFILE') ? 'E2:ICC' : tag);
    i += 2 + len;
  }
  return ms;
}

/** Output checker (port of the QA check_out.py, without the external qpdf --check). */
async function checkOut(bytes) {
  const issues = [];
  const raw = latin1(bytes);
  for (const p of RAW_BAD) if (raw.includes(p)) issues.push(`raw:${p}`);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  if (ctx.trailerInfo.Info) issues.push('trailer/Info');
  const extra = doc.catalog.keys().map((k) => k.decodeText()).filter((k) => k !== 'Type' && k !== 'Pages');
  if (extra.length) issues.push(`catalog-extra:${extra}`);
  let decoded = '';
  const walk = (o, depth = 0) => {
    if (depth > 200) return;
    const d = o instanceof PDFDict ? o : o instanceof PDFRawStream ? o.dict : undefined;
    if (d) {
      for (const [key, v] of d.entries()) {
        const k = key.decodeText();
        if (BAD_NAMES.has(k)) issues.push(`key/${k}`);
        if (v instanceof PDFName && BAD_NAMES.has(v.decodeText())) issues.push(`val/${k}=${v.decodeText()}`);
        if (k === 'Subtype' && v instanceof PDFName && BAD_ANNOTS.has(v.decodeText())) issues.push(`annot:${v.decodeText()}`);
        if (k === 'URI') {
          const u = v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '?';
          if (!OK_URI.test(u)) issues.push(`uri:${u.slice(0, 40)}`);
        }
        if (v instanceof PDFDict || v instanceof PDFArray) walk(v, depth + 1);
      }
    } else if (o instanceof PDFArray) {
      for (const v of o.asArray()) {
        if (v instanceof PDFName && BAD_NAMES.has(v.decodeText())) issues.push(`arrval=${v.decodeText()}`);
        if (v instanceof PDFDict || v instanceof PDFArray) walk(v, depth + 1);
      }
    }
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    walk(obj);
    if (!(obj instanceof PDFRawStream)) continue;
    const f = obj.dict.lookup(PDFName.of('Filter'));
    const filters = f instanceof PDFName ? [f.decodeText()] : f instanceof PDFArray ? f.asArray().map((x) => x.decodeText()) : [];
    if (filters.at(-1) === 'DCTDecode') {
      if (filters.length !== 1) issues.push(`dct-chain:${filters}`);
      const bad = jpegMarkers(obj.contents).filter((m) => /^E[1-9A-F]$/.test(m) && m !== 'EE' || m === 'FE' || m === 'E2');
      if (bad.length) issues.push(`jpeg-markers:${bad}`);
      decoded += latin1(obj.contents);
    } else {
      try { decoded += latin1(decodePDFRawStream(obj).decode()); } catch { decoded += latin1(obj.contents); }
    }
  }
  for (const p of DECODED_BAD) if (decoded.includes(p)) issues.push(`decoded:${JSON.stringify(p)}`);
  return { issues: [...new Set(issues)], pages: doc.getPageCount(), doc };
}

const outsOf = (r) => (r instanceof Uint8Array ? [r] : Array.isArray(r) && r[0] && r[0].bytes ? r.map((p) => p.bytes) : []);

/** Run one case; returns 'ok' or the PdfToolError code; every output is checked. */
async function run(op, a) {
  try {
    let r;
    if (op === 'info') r = await core.pdfInfo(a.file);
    else if (op === 'merge') r = await core.merge(a.items);
    else if (op === 'split') r = await core.split(a.file, a.ranges);
    else if (op === 'organize') r = await core.organize(a.file, a.ops);
    else if (op === 'images') r = await core.imagesToPdf(a.items, ...('options' in a ? [a.options] : []));
    else if (op === 'ranges') r = core.parsePageRanges(a.spec, a.count);
    for (const o of outsOf(r)) {
      const { issues } = await checkOut(o);
      assert.deepEqual(issues, [], `${op}: output issues`);
    }
    return 'ok';
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    assert.ok(e instanceof core.PdfToolError, `every error must be a PdfToolError, got ${e && e.stack}`);
    return e.code;
  }
}

async function cases(list) {
  const fails = [];
  for (const [id, op, args, exp] of list) {
    const got = await run(op, typeof args === 'function' ? await args() : args);
    const ok = Array.isArray(exp) ? exp.includes(got) : got === exp;
    if (!ok) fails.push(`${id}: expected ${exp}, got ${got}`);
  }
  assert.deepEqual(fails, []);
}

const pdf = (n) => ({ file: rd(n) });
const one = (n) => ({ items: [{ bytes: rd(n) }] });

test('QA: encrypted inputs (RC4-40/128, AES-128/256, owner-only, object streams) -> PDF_ENCRYPTED', async () => {
  const L = [];
  for (const n of ['enc-user-rc4', 'enc-owneronly-rc4', 'enc-user-rc4-40', 'enc-user-aes128', 'enc-user-aes256', 'enc-owneronly-aes256', 'enc-owneronly-aes256-objstm']) {
    L.push([`${n}:info`, 'info', pdf(`${n}.pdf`), 'PDF_ENCRYPTED'], [`${n}:merge`, 'merge', one(`${n}.pdf`), 'PDF_ENCRYPTED']);
  }
  await cases(L);
});

test('QA: active content, metadata and attachments never reach any output (merge/split/organize)', async () => {
  const L = [];
  for (const n of ['plain-3', 'js-openaction', 'js-page-aa', 'js-link-actions', 'js-next-chain', 'js-uri-variants', 'js-names', 'embedded-file',
    'fileattach-annot', 'acroform-filled', 'xfa', 'page-af', 'page-privkeys', 'xobject-metadata', 'metadata-xmp', 'pdf-embedded-exif-jpeg']) {
    L.push([`${n}:merge`, 'merge', one(`${n}.pdf`), 'ok'], [`${n}:split`, 'split', { ...pdf(`${n}.pdf`), ranges: '1' }, 'ok'],
      [`${n}:organize`, 'organize', { ...pdf(`${n}.pdf`), ops: { order: [0, 0] } }, 'ok']);
  }
  await cases(L);
});

test('QA blocker 1: JPEG inside a PDF keeps ICC/Adobe, loses EXIF/GPS (N12/W98 canary), XMP, IPTC, COM', async () => {
  const src = rd('pdf-embedded-exif-jpeg.pdf');
  // the fixture stores the JPEG as [/ASCII85Decode /DCTDecode]; decode it to prove the canaries are there
  const srcDoc = await PDFDocument.load(src, { updateMetadata: false });
  let srcJpeg = '';
  for (const [, o] of srcDoc.context.enumerateIndirectObjects()) {
    if (o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) srcJpeg += latin1(decodePDFRawStream(srcDoc.context.stream(o.contents, { Filter: 'ASCII85Decode' })).decode());
  }
  for (const s of ['LEAKSERIAL123', 'LEAK-OWNER', 'Exif', 'xmpmeta', 'LEAK-IPTC', 'LEAK-COM']) assert.ok(srcJpeg.includes(s), `fixture carries ${s}`);
  for (const out of [await core.merge([{ bytes: src }]), (await core.split(src, '1'))[0].bytes, await core.organize(src, { order: [0] })]) {
    const { issues, doc } = await checkOut(out);
    assert.deepEqual(issues, []);
    let jpegs = 0;
    for (const [, o] of doc.context.enumerateIndirectObjects()) {
      if (o instanceof PDFRawStream && o.dict.lookup(PDFName.of('Filter')) === PDFName.of('DCTDecode')) {
        jpegs++;
        assert.ok(!jpegMarkers(o.contents).some((m) => ['E1', 'ED', 'FE'].includes(m)));
      }
    }
    assert.ok(jpegs >= 1, 'image is still there');
  }
});

test('QA: broken, cyclic and deeply nested inputs fail as PdfToolError or work, never hang', async () => {
  const L = [];
  for (const n of ['broken-truncated', 'broken-garbage', 'broken-garbage-header', 'broken-header-only', 'broken-header-eof', 'broken-empty', 'zero-pages']) {
    L.push([`${n}:info`, 'info', pdf(`${n}.pdf`), 'PDF_INVALID'], [`${n}:merge`, 'merge', one(`${n}.pdf`), 'PDF_INVALID']);
  }
  for (const n of ['broken-xref', 'broken-xref-offsets']) L.push([`${n}:merge`, 'merge', one(`${n}.pdf`), ['ok', 'PDF_INVALID']]);
  for (const n of ['bomb-deep-array', 'bomb-deep-array-3k', 'cycle-kids', 'cycle-kids-2', 'cycle-parent', 'cycle-parent-self', 'count-lie', 'huge-mediabox']) {
    L.push([`${n}:info`, 'info', pdf(`${n}.pdf`), ['ok', 'PDF_INVALID']], [`${n}:merge`, 'merge', one(`${n}.pdf`), ['ok', 'PDF_INVALID']],
      [`${n}:organize`, 'organize', { ...pdf(`${n}.pdf`), ops: { order: [0], rotate: { 0: 90 } } }, ['ok', 'PDF_INVALID']]);
  }
  L.push(['cycle-kids:info', 'info', pdf('cycle-kids.pdf'), 'PDF_INVALID'], ['count-lie:info', 'info', pdf('count-lie.pdf'), 'ok'],
    ['huge-mediabox-valid:merge', 'merge', one('huge-mediabox-valid.pdf'), 'ok'],
    ['huge-mediabox-valid:organize', 'organize', { ...pdf('huge-mediabox-valid.pdf'), ops: { order: [0], rotate: { 0: -90 } } }, 'ok']);
  await cases(L);
});

test('QA: page and file limits (split per part and in total, checked before copying)', async () => {
  const p2000 = await fx.plainPdf(2000);
  const p1001 = await fx.plainPdf(1001);
  const plain = rd('plain-3.pdf');
  await cases([
    ['pages-2000:info', 'info', { file: p2000 }, 'ok'],
    ['pages-2000:merge-all', 'merge', { items: [{ bytes: p2000 }] }, 'TOO_MANY_PAGES'],
    ['pages-2000:split-1-1000', 'split', { file: p2000, ranges: '1-1000' }, 'ok'],
    ['pages-2000:split-1-1001', 'split', { file: p2000, ranges: '1-1001' }, 'TOO_MANY_PAGES'],
    // was TOO_MANY_PAGES while MAX_PAGES capped all parts together; now 500 + 502 pages in two parts is fine
    ['pages-2000:split-pairs-1002', 'split', { file: p2000, ranges: [[1, 500], [1000, 1501]] }, 'ok'],
    ['pages-2000:split-total-5001', 'split', { file: p2000, ranges: '1-1000,1-1000,1-1000,1-1000,1-1000,1' }, 'TOO_MANY_PAGES'],
    ['pages-2000:merge-range-1000', 'merge', { items: [{ bytes: p2000, pages: '1001-2000' }] }, 'ok'],
    ['pages-1001:merge', 'merge', { items: [{ bytes: p1001 }] }, 'TOO_MANY_PAGES'],
    ['merge-600+401', 'merge', { items: [{ bytes: p2000, pages: '1-600' }, { bytes: p2000, pages: '1-401' }] }, 'TOO_MANY_PAGES'],
    ['organize-1001-dups', 'organize', { file: plain, ops: { order: Array(1001).fill(0) } }, 'TOO_MANY_PAGES'],
    ['organize-1000-dups', 'organize', { file: plain, ops: { order: Array(1000).fill(0) } }, 'ok'],
    ['split-51-parts', 'split', { file: p2000, ranges: Array.from({ length: 51 }, (_, k) => String(k + 1)).join(',') }, 'TOO_MANY_FILES'],
    ['too-large-file', 'merge', { items: [{ bytes: new Uint8Array(100 * MB + 1) }] }, 'TOO_LARGE'],
    ['exact-100MB-file', 'merge', { items: [{ bytes: new Uint8Array(100 * MB) }] }, 'PDF_INVALID'],
    ['too-large-image', 'images', { items: [{ bytes: new Uint8Array(100 * MB + 1) }] }, 'TOO_LARGE'],
    ['too-many-files', 'merge', { items: Array(51).fill({ bytes: plain }) }, 'TOO_MANY_FILES'],
    ['50-files', 'merge', { items: Array(50).fill({ bytes: plain }) }, 'ok'],
    ['too-many-images', 'images', { items: Array(51).fill({ bytes: rd('jpg-as.png') }) }, 'TOO_MANY_FILES'],
    ['empty-list', 'merge', { items: [] }, 'PDF_INVALID'],
  ]);
});

test('QA: page ranges (open ranges valid; PAGE_RANGE only outside 1..N, reversed or unparseable)', async () => {
  const OK = new Set(['-1', '1,,2', '3-', '-2', '1，2', '1–2', '1 - 3']);
  const L = [];
  for (const spec of ['0', '-1', '5-3', '999', '1,,2', '99999999999999999999', '1e3', '١', '１', '٣-١', '1-2-3', '', ' ', ',', '--', '0x1', '+1', '1.5', 'a', '3-', '-2', '1，2', '1–2', '1 - 3', '-4', '4-']) {
    L.push([`ranges:${JSON.stringify(spec)}`, 'ranges', { spec, count: 3 }, OK.has(spec) ? 'ok' : 'PAGE_RANGE']);
  }
  const plain = rd('plain-3.pdf');
  L.push(['split:range-0', 'split', { file: plain, ranges: '0' }, 'PAGE_RANGE'],
    ['split:huge', 'split', { file: plain, ranges: '1-99999999999999999999' }, 'PAGE_RANGE'],
    ['split:pairs-float', 'split', { file: plain, ranges: [[1.5, 2]] }, 'PAGE_RANGE'],
    ['split:pairs-rev', 'split', { file: plain, ranges: [[3, 1]] }, 'PAGE_RANGE'],
    ['split:open', 'split', { file: plain, ranges: '-1,2-' }, 'ok'],
    ['merge:idx-neg', 'merge', { items: [{ bytes: plain, pages: [-1] }] }, 'PAGE_RANGE'],
    ['merge:idx-3', 'merge', { items: [{ bytes: plain, pages: [3] }] }, 'PAGE_RANGE'],
    ['merge:range-nonascii', 'merge', { items: [{ bytes: plain, pages: '١-٣' }] }, 'PAGE_RANGE'],
    ['merge:dups', 'merge', { items: [{ bytes: plain, pages: [2, 0, 0, 2] }] }, 'ok']);
  for (const [deg, exp] of [[-90, 'ok'], [450, 'ok'], [45, 'PAGE_RANGE'], [90.5, 'PAGE_RANGE'], ['90', 'PAGE_RANGE'], [null, 'PAGE_RANGE'], [1e21, 'PAGE_RANGE'], [-720, 'ok'], [0, 'ok'], [360, 'ok']]) {
    L.push([`rotate:${deg}`, 'organize', { file: plain, ops: { order: [2, 0, 0], rotate: { 0: deg } } }, exp]);
  }
  L.push(['rotate:key-neg', 'organize', { file: plain, ops: { order: [0], rotate: { '-1': 90 } } }, 'PAGE_RANGE'],
    ['organize:empty', 'organize', { file: plain, ops: { order: [] } }, 'PAGE_RANGE']);
  await cases(L);
  assert.deepEqual(core.parsePageRanges('-1', 3), [[0]]);
});

test('QA: images (orientations, metadata, magic bytes, size limits, options)', async () => {
  const img = (n) => ({ items: [{ bytes: rd(n) }] });
  const L = [];
  for (let o = 1; o <= 8; o++) L.push([`jpeg-gps-o${o}`, 'images', img(`jpeg-gps-o${o}.jpg`), 'ok']);
  for (const n of ['jpeg-cmyk-app14.jpg', 'jpeg-icc.jpg', 'jpeg-progressive-o6.jpg', 'png-meta.png', 'png-palette-trns.png', 'png-16bit-gray.png', 'png-as.jpg', 'jpg-as.png']) {
    L.push([n, 'images', { items: [{ bytes: rd(n), type: n.endsWith('.jpg') ? 'image/jpeg' : 'image/png' }] }, 'ok']);
  }
  for (const n of ['webp-as.jpg', 'gif-as.jpg', 'heic-as.jpg', 'bmp-as.png', 'tiff-as.jpg', 'plain-3.pdf']) {
    L.push([`unsupported:${n}`, 'images', { items: [{ bytes: rd(n), type: 'image/jpeg' }] }, 'UNSUPPORTED_IMAGE']);
  }
  for (const n of ['jpeg-60000x60000.jpg', 'jpeg-7072x7072.jpg', 'png-60000x60000.png']) L.push([n, 'images', img(n), 'IMAGE_TOO_LARGE']);
  L.push(['jpeg-7071x7071.jpg', 'images', img('jpeg-7071x7071.jpg'), ['ok', 'IMAGE_INVALID']],
    ['jpeg-truncated.jpg', 'images', img('jpeg-truncated.jpg'), ['ok', 'IMAGE_INVALID']],
    ['png-truncated.png', 'images', img('png-truncated.png'), 'IMAGE_INVALID'],
    ['images-mixed-9', 'images', { items: [...Array.from({ length: 8 }, (_, k) => ({ bytes: rd(`jpeg-gps-o${k + 1}.jpg`) })), { bytes: rd('png-meta.png') }] }, 'ok']);
  const J1 = 'jpeg-gps-o1.jpg';
  const J6 = 'jpeg-gps-o6.jpg';
  for (const [nm, options, exp] of [['margin-neg', { margin: -1 }, 'PDF_INVALID'], ['margin-NaN', { margin: NaN }, 'PDF_INVALID'],
    ['margin-Inf', { margin: Infinity }, 'PDF_INVALID'], ['margin--Inf', { margin: -Infinity }, 'PDF_INVALID'], ['margin-str', { margin: '10' }, 'PDF_INVALID'],
    ['margin-1e308', { margin: 1e308 }, 'PDF_INVALID'], ['margin-null', { margin: null }, 'PDF_INVALID'], ['margin--0', { margin: -0 }, 'ok'],
    ['fit-margin-3600', { margin: 3600 }, 'PDF_INVALID'], ['fit-margin-3599.9', { margin: 3599.9 }, 'ok'],
    ['A4-margin-297.64', { pageSize: 'A4', margin: 297.64 }, 'PDF_INVALID'], ['A4-margin-297', { pageSize: 'A4', margin: 297 }, 'ok'],
    ['A4-margin-400', { pageSize: 'A4', margin: 400 }, 'PDF_INVALID'], ['Letter-margin-306', { pageSize: 'Letter', margin: 306 }, 'PDF_INVALID'],
    ['Letter-margin-305', { pageSize: 'Letter', margin: 305 }, 'ok'], ['A4-o6-m36', { pageSize: 'A4', margin: 36 }, 'ok'], ['Letter-o6-m0', { pageSize: 'Letter' }, 'ok'],
    ['pageSize-a4', { pageSize: 'a4' }, 'PDF_INVALID'], ['pageSize-A3', { pageSize: 'A3' }, 'PDF_INVALID'], ['pageSize-empty', { pageSize: '' }, 'PDF_INVALID'],
    ['pageSize-null', { pageSize: null }, 'PDF_INVALID'], ['pageSize-num', { pageSize: 4 }, 'PDF_INVALID'], ['pageSize-proto', { pageSize: '__proto__' }, 'PDF_INVALID'],
    ['pageSize-toString', { pageSize: 'toString' }, 'PDF_INVALID'], ['pageSize-constructor', { pageSize: 'constructor' }, 'PDF_INVALID'],
    ['pageSize-array', { pageSize: [595, 842] }, 'PDF_INVALID'], ['options-array', [], 'PDF_INVALID'], ['options-string', 'A4', 'PDF_INVALID'],
    ['options-null', null, 'ok'], ['options-fit', { pageSize: 'fit' }, 'ok']]) {
    L.push([`opt:${nm}`, 'images', { items: [{ bytes: rd(nm.includes('o6') ? J6 : J1) }], options }, exp]);
  }
  L.push(['opt:fit-m3599-20000x2000', 'images', { items: [{ bytes: rd('jpeg-20000x2000-o6.jpg') }], options: { margin: 3599 } }, 'ok'],
    ['opt:A4-20000x2000', 'images', { items: [{ bytes: rd('jpeg-20000x2000-o1.jpg') }], options: { pageSize: 'A4', margin: 10 } }, 'ok'],
    ['opt:A4-60000-still-rejected', 'images', { items: [{ bytes: rd('jpeg-60000x60000.jpg') }], options: { pageSize: 'A4' } }, 'IMAGE_TOO_LARGE'],
    ['opt:A4-meta-png', 'images', { items: [{ bytes: rd('png-meta.png') }, { bytes: rd('jpeg-cmyk-app14.jpg') }], options: { pageSize: 'Letter', margin: 20 } }, 'ok']);
  await cases(L);
});

test('QA checker itself: flags the unsanitized fixtures (so a clean result means something)', async () => {
  for (const n of ['js-openaction', 'js-page-aa', 'page-af', 'page-privkeys', 'xobject-metadata', 'metadata-xmp', 'embedded-file']) {
    const { issues } = await checkOut(rd(`${n}.pdf`));
    assert.ok(issues.length > 0, `${n}: checker must report the raw fixture`);
  }
});

// --- QA aea0eb0 (v2): full suite.py 'v2:' set, fixtures in test/qa/fixtures/v2 (generator gen_variants.py, synthetic).
const V2 = ['exif-indirect-subtype', 'exif-hex-flate-dct', 'exif-smask-nested-pattern', 'exif-midscan-trailer', 'xmeta-alternates-smask',
  'af-form-privdata', 'privkeys-indirect-s', 'inherited-pages-af'];

test('QA v2: leak variants (indirect /S /Type /Subtype, DCT chains, SMask/Pattern, private keys, inherited /AF) are clean in merge/split/organize', async () => {
  const L = [];
  for (const n of V2) {
    const p = `v2/${n}.pdf`;
    L.push([`v2:${n}:merge`, 'merge', one(p), 'ok'], [`v2:${n}:split`, 'split', { ...pdf(p), ranges: '1' }, 'ok'],
      [`v2:${n}:organize`, 'organize', { ...pdf(p), ops: { order: [0, 0] } }, 'ok']);
  }
  await cases(L);
});

test('QA v2 blockers: Launch with indirect /S and /Type, EXIF with indirect /Subtype, private stream under a Form XObject', async () => {
  const raw = (n) => latin1(rd(`v2/${n}.pdf`));
  assert.match(raw('privkeys-indirect-s'), /calc\.exe/);
  for (const [n, bad] of [['privkeys-indirect-s', ['calc.exe', 'cmd.exe', '/Launch', '/Win']], ['exif-indirect-subtype', ['Exif', 'GPS', 'LEAK']],
    ['af-form-privdata', ['LEAK-PRIVATE-STREAM-PAYLOAD', 'PrivData']]]) {
    const src = rd(`v2/${n}.pdf`);
    for (const out of [await core.merge([{ bytes: src }]), (await core.split(src, '1'))[0].bytes, await core.organize(src, { order: [0] })]) {
      const { doc } = await checkOut(out);
      let text = latin1(out);
      for (const [, o] of doc.context.enumerateIndirectObjects()) {
        if (o instanceof PDFRawStream) { try { text += latin1(decodePDFRawStream(o).decode()); } catch { /* DCT */ } }
      }
      for (const b of bad) assert.ok(!text.includes(b), `${n}: ${b} in output`);
    }
  }
});

test('QA v2: limits (ObjStm bombs in split/organize, duplicate split ranges, open ranges) and ranges', async () => {
  const bomb1g = objStmBombPdf(deflateBombRepeated(1024 * MB));
  const bomb4g = objStmBombPdf(deflateBombRepeated(4096 * MB));
  const p2000 = await fx.plainPdf(2000);
  const plain = rd('plain-3.pdf');
  const L = [
    ['v2:bomb-objstm-1g:merge', 'merge', { items: [{ bytes: bomb1g }] }, 'TOO_LARGE'],
    ['v2:bomb-objstm-4g:split', 'split', { file: bomb4g, ranges: '1' }, 'TOO_LARGE'],
    ['v2:bomb-objstm-4g:organize', 'organize', { file: bomb4g, ops: { order: [0] } }, 'TOO_LARGE'],
    ['v2:split-dup-1000x5', 'split', { file: p2000, ranges: Array(5).fill('1-1000').join(',') }, 'ok'],
    ['v2:split-dup-total-5001', 'split', { file: p2000, ranges: Array(5).fill('1-1000').join(',') + ',1' }, 'TOO_MANY_PAGES'],
    ['v2:split-dup-1x51', 'split', { file: plain, ranges: Array(51).fill('1').join(',') }, 'TOO_MANY_FILES'],
    ['v2:split-dup-1x50', 'split', { file: plain, ranges: Array(50).fill('1').join(',') }, 'ok'],
    ['v2:split-pairs-dup-total', 'split', { file: p2000, ranges: [...Array(5).fill([1, 1000]), [1, 1]] }, 'TOO_MANY_PAGES'],
    ['v2:split-pairs-51', 'split', { file: plain, ranges: Array(51).fill([1, 1]) }, 'TOO_MANY_FILES'],
    // suite.py expects TOO_MANY_PAGES; a >10 000-char range string is rejected earlier as unparseable (QA finding 4, LOW)
    ['v2:split-huge-dup-string', 'split', { file: p2000, ranges: Array(3000).fill('1-2000').join(',') }, ['TOO_MANY_PAGES', 'PAGE_RANGE']],
    ['v2:split-open-1001', 'split', { file: p2000, ranges: '1000-' }, 'TOO_MANY_PAGES'],
    ['v2:split-open-head', 'split', { file: p2000, ranges: '-1000' }, 'ok'],
  ];
  for (const [spec, exp] of [['-3', 'ok'], ['3-', 'ok'], ['-1', 'ok'], ['2-', 'ok'], ['-4', 'PAGE_RANGE'], ['4-', 'PAGE_RANGE'], ['3-2', 'PAGE_RANGE'],
    ['0-', 'PAGE_RANGE'], ['-0', 'PAGE_RANGE'], ['x', 'PAGE_RANGE'], ['1-2-', 'PAGE_RANGE'], ['--1', 'PAGE_RANGE']]) {
    L.push([`v2:ranges:${JSON.stringify(spec)}`, 'ranges', { spec, count: 3 }, exp]);
  }
  await cases(L);
});
