import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import { pdfInfo, merge, split, organize, imagesToPdf, LIMITS, ERROR_CODES, PdfToolError } from '../src/index.js';
import * as fx from '../test/fixtures/gen.mjs';
import { dump, expectCode, pageWidths, assertClean, latin1 } from './helpers.mjs';

test('contract constants', () => {
  assert.deepEqual({ ...LIMITS }, {
    MAX_FILE_BYTES: 100 * 1024 * 1024,
    MAX_TOTAL_BYTES: 300 * 1024 * 1024,
    MAX_PAGES: 1000,
    MAX_FILES: 50,
    MAX_IMAGE_PIXELS: 50_000_000,
    MAX_DECOMPRESSED_BYTES: 500 * 1024 * 1024,
    MAX_SPLIT_TOTAL_PAGES: 5000,
    MAX_SPLIT_PARTS: 50,
  });
  assert.ok(Object.isFrozen(LIMITS));
  assert.deepEqual([...ERROR_CODES], ['PDF_ENCRYPTED', 'PDF_INVALID', 'PAGE_RANGE', 'TOO_LARGE', 'TOO_MANY_PAGES',
    'TOO_MANY_FILES', 'IMAGE_TOO_LARGE', 'UNSUPPORTED_IMAGE', 'IMAGE_INVALID']);
  const e = new PdfToolError('PDF_INVALID', 'x');
  assert.ok(e instanceof Error);
  assert.equal(e.code, 'PDF_INVALID');
});

test('pdfInfo', async () => {
  assert.deepEqual(await pdfInfo(await fx.plainPdf(3)), { pages: 3 });
  assert.deepEqual(await pdfInfo(await fx.evilPdf()), { pages: 2 });
  await expectCode(pdfInfo(fx.encryptedPdf()), 'PDF_ENCRYPTED');
  await expectCode(pdfInfo(fx.corruptBytes()), 'PDF_INVALID');
  await expectCode(pdfInfo(fx.truncatedPdf()), 'PDF_INVALID');
  await expectCode(pdfInfo(new Uint8Array(0)), 'PDF_INVALID');
  await expectCode(pdfInfo('not bytes'), 'PDF_INVALID');
  await expectCode(pdfInfo(new ArrayBuffer(10)), 'PDF_INVALID');
});

test('encrypted fixture really has /Encrypt in the trailer', () => {
  assert.match(latin1(fx.encryptedPdf()), /trailer\n<<[^>]*\/Encrypt 4 0 R/);
});

test('encrypted input -> PDF_ENCRYPTED in every operation', async () => {
  const enc = fx.encryptedPdf();
  const e = await expectCode(merge([{ bytes: await fx.plainPdf(1) }, { bytes: enc }]), 'PDF_ENCRYPTED');
  assert.equal(e.details.index, 1);
  await expectCode(split(enc, '1'), 'PDF_ENCRYPTED');
  await expectCode(pdfInfo(enc), 'PDF_ENCRYPTED');
  await expectCode(organize(enc, { order: [0] }), 'PDF_ENCRYPTED');
});

test('corrupt input -> PDF_INVALID', async () => {
  for (const bad of [fx.corruptBytes(), fx.truncatedPdf(), new TextEncoder().encode('%PDF-1.7\n%%EOF')]) {
    await expectCode(merge([{ bytes: bad }]), 'PDF_INVALID');
    await expectCode(split(bad, '1'), 'PDF_INVALID');
    await expectCode(organize(bad, { order: [0] }), 'PDF_INVALID');
  }
  await expectCode(merge([]), 'PDF_INVALID');
  await expectCode(merge([{ bytes: 'x' }]), 'PDF_INVALID');
  await expectCode(merge('x'), 'PDF_INVALID');
});

test('merge: order and page selection', async () => {
  const a = await fx.plainPdf(3); // widths 101..103
  const b = await fx.plainPdf(5); // widths 101..105
  const out = await merge([{ bytes: a }, { bytes: b, pages: '5,1-2' }, { bytes: a, pages: [2, 0] }]);
  assert.ok(out instanceof Uint8Array);
  assert.deepEqual(await pageWidths(out), [101, 102, 103, 105, 101, 102, 103, 101]);
  await assertClean(out);
  await expectCode(merge([{ bytes: a, pages: '4' }]), 'PAGE_RANGE');
  await expectCode(merge([{ bytes: a, pages: [3] }]), 'PAGE_RANGE');
  await expectCode(merge([{ bytes: a, pages: [] }]), 'PAGE_RANGE');
  await expectCode(merge([{ bytes: a, pages: {} }]), 'PAGE_RANGE');
});

test('merge: PAGE_RANGE details name the item, position, page and page count', async () => {
  const a = await fx.plainPdf(3);
  const b = await fx.plainPdf(5);
  let e = await expectCode(merge([{ bytes: a }, { bytes: b, pages: [0, 4, 7, 1] }]), 'PAGE_RANGE');
  assert.equal(e.message, 'Page index out of range 0-4');
  assert.deepEqual(e.details, { index: 1, position: 2, page: 7, pageCount: 5 });
  e = await expectCode(merge([{ bytes: a, pages: [0, 'x'] }]), 'PAGE_RANGE');
  assert.deepEqual(e.details, { index: 0, position: 1, page: null, pageCount: 3 });
  e = await expectCode(merge([{ bytes: b }, { bytes: a, pages: '2-4' }]), 'PAGE_RANGE');
  assert.equal(e.message, 'Page out of range 1-3');
  assert.deepEqual(e.details, { index: 1, from: 2, to: 4, pageCount: 3 });
  e = await expectCode(merge([{ bytes: a, pages: [] }]), 'PAGE_RANGE');
  assert.deepEqual(e.details, { index: 0, pageCount: 3 });
});

test('split: one document per group, 1-based pages reported', async () => {
  const src = await fx.plainPdf(6);
  const res = await split(src, '1-3，5, 6–6');
  assert.equal(res.length, 3);
  assert.deepEqual(res.map((r) => r.pages), [[1, 2, 3], [5], [6]]);
  assert.deepEqual(await pageWidths(res[0].bytes), [101, 102, 103]);
  assert.deepEqual(await pageWidths(res[1].bytes), [105]);
  assert.deepEqual(await pageWidths(res[2].bytes), [106]);
  for (const r of res) await assertClean(r.bytes);
  // array form: [from, to] 1-based, one output per pair
  const arr = await split(src, [[2, 4], [6, 6]]);
  assert.deepEqual(arr.map((r) => r.pages), [[2, 3, 4], [6]]);
  assert.deepEqual(await pageWidths(arr[0].bytes), [102, 103, 104]);
  for (const bad of [[], [[0, 1]], [[1, 7]], [[3, 2]], [[1]], [[1, 2, 3]], [['1', '2']], [1, 2], {}, null]) {
    await expectCode(split(src, bad), 'PAGE_RANGE');
  }
  await expectCode(split(src, '7'), 'PAGE_RANGE');
  await expectCode(split(src, ''), 'PAGE_RANGE');
});

test('organize: order is final sequence, absent pages deleted, rotation added', async () => {
  const doc = await PDFDocument.create();
  for (let k = 1; k <= 4; k++) doc.addPage([100 + k, 200]);
  doc.getPage(1).setRotation({ type: 'degrees', angle: 90 });
  const src = await doc.save();
  const out = await organize(src, { order: [3, 0, 1], rotate: { 0: 90, 1: -90, 3: 540 } });
  const res = await PDFDocument.load(out, { updateMetadata: false });
  assert.deepEqual(res.getPages().map((p) => Math.round(p.getWidth())), [104, 101, 102]);
  assert.deepEqual(res.getPages().map((p) => p.getRotation().angle), [180, 90, 0]);
  await assertClean(out);
  // order without rotate
  assert.deepEqual(await pageWidths(await organize(src, { order: [2] })), [103]);
  // duplicates allowed; rotation applies to every copy; normalized mod 360
  const dup = await PDFDocument.load(await organize(src, { order: [0, 0, 2, 0], rotate: { 0: -450 } }), { updateMetadata: false });
  assert.deepEqual(dup.getPages().map((p) => Math.round(p.getWidth())), [101, 101, 103, 101]);
  assert.deepEqual(dup.getPages().map((p) => p.getRotation().angle), [270, 270, 0, 270]);
});

test('organize: invalid ops -> PAGE_RANGE', async () => {
  const src = await fx.plainPdf(3);
  for (const ops of [undefined, null, {}, { order: [] }, { order: [3] }, { order: [-1] }, { order: [0.5] },
    { order: '0' }, { order: [0], rotate: { 0: 45 } }, { order: [0], rotate: { 5: 90 } }, { order: [0], rotate: { x: 90 } },
    { order: [0], rotate: [90] }, { order: [0], rotate: { 0: '90' } }]) {
    await expectCode(organize(src, ops), 'PAGE_RANGE');
  }
});

test('organize: PAGE_RANGE details (index = position in order, page = original index)', async () => {
  const src = await fx.plainPdf(3);
  let e = await expectCode(organize(src, { order: [2, 0, 5, 1] }), 'PAGE_RANGE');
  assert.equal(e.message, 'order index out of range 0-2');
  assert.deepEqual(e.details, { index: 2, page: 5, pageCount: 3 });
  e = await expectCode(organize(src, { order: [1, -1] }), 'PAGE_RANGE');
  assert.deepEqual(e.details, { index: 1, page: -1, pageCount: 3 });
  e = await expectCode(organize(src, { order: [0, '1'] }), 'PAGE_RANGE');
  assert.deepEqual(e.details, { index: 1, page: null, pageCount: 3 });
  e = await expectCode(organize(src, { order: [] }), 'PAGE_RANGE');
  assert.deepEqual(e.details, { pageCount: 3 });
  e = await expectCode(organize(src, { order: [0], rotate: { 4: 90 } }), 'PAGE_RANGE');
  assert.deepEqual(e.details, { page: 4, pageCount: 3 });
  e = await expectCode(organize(src, { order: [0], rotate: { 1: 45 } }), 'PAGE_RANGE');
  assert.deepEqual(e.details, { page: 1, degrees: 45, pageCount: 3 });
});

test('sanitization: metadata, XMP, JS, actions, forms, attachments removed; safe URI link kept', async () => {
  const evil = await fx.evilPdf();
  // The fixture really contains everything we claim to remove.
  const raw = latin1(evil);
  for (const s of ['/JavaScript', '/Launch', '/SubmitForm', '/ImportData', '/GoToR', '/GoToE', '/AcroForm', '/Widget',
    '/OpenAction', '/Metadata', '/EmbeddedFile', '/AA', 'EVIL-XMP', 'EVIL-PAGE-AA-OPEN', 'EVIL-LINK-JS', fx.SAFE_LINK_URI]) {
    assert.ok(raw.includes(s), `fixture should contain ${s}`);
  }
  const [part1, part2] = await split(evil, '1,2');
  const outputs = [
    [await merge([{ bytes: evil }]), 1],
    [await organize(evil, { order: [1, 0] }), 1],
    [part1.bytes, 1], // page 1 carries the links
    [part2.bytes, 0],
  ];
  for (const [out, wantLinks] of outputs) {
    const { doc, text } = await assertClean(out);
    assert.equal(text.includes(fx.SAFE_LINK_URI), wantLinks === 1, 'safe link kept');
    const links = doc.getPages().flatMap((p) => p.node.lookup(PDFName.of('Annots'))?.asArray() ?? []);
    assert.equal(links.length, wantLinks, 'exactly the one safe link survives');
  }
});

test('internal /Dest link does not drag deleted pages into the output', async () => {
  // evil page 1 has a /Dest link to page 2; splitting off page 1 must give a 1-page doc
  // with no second page object hiding in the file.
  const [one] = await split(await fx.evilPdf(), '1');
  const { doc, text } = await dump(one.bytes);
  assert.equal(doc.getPageCount(), 1);
  assert.equal((text.match(/\/Type \/Page\b/g) || []).length, 1);
});

test('limits: file size, total size, file count (checked before parsing)', async () => {
  const big = new Uint8Array(LIMITS.MAX_FILE_BYTES + 1);
  await expectCode(pdfInfo(big), 'TOO_LARGE');
  await expectCode(merge([{ bytes: big }]), 'TOO_LARGE');
  await expectCode(split(big, '1'), 'TOO_LARGE');
  await expectCode(organize(big, { order: [0] }), 'TOO_LARGE');
  await expectCode(imagesToPdf([{ bytes: big }]), 'TOO_LARGE');
  const part = new Uint8Array(80 * 1024 * 1024); // 4 x 80 MB = 320 MB > 300 MB
  await expectCode(merge([part, part, part, part].map((bytes) => ({ bytes }))), 'TOO_LARGE');
  await expectCode(imagesToPdf([part, part, part, part].map((bytes) => ({ bytes }))), 'TOO_LARGE');
  const tiny = await fx.plainPdf(1);
  await expectCode(merge(Array(LIMITS.MAX_FILES + 1).fill({ bytes: tiny })), 'TOO_MANY_FILES');
  await expectCode(imagesToPdf(Array(LIMITS.MAX_FILES + 1).fill({ bytes: fx.plainPng() })), 'TOO_MANY_FILES');
  const ok = await merge(Array(LIMITS.MAX_FILES).fill({ bytes: tiny }));
  assert.equal((await pdfInfo(ok)).pages, 50);
});

test('limits: MAX_PAGES applies to the result only', async () => {
  const p1001 = await fx.plainPdf(1001);
  assert.deepEqual(await pdfInfo(p1001), { pages: 1001 });
  // a long input is fine when the result is small
  assert.equal((await pdfInfo(await merge([{ bytes: p1001, pages: '1-10' }]))).pages, 10);
  assert.equal((await split(p1001, '1001'))[0].pages[0], 1001);
  assert.equal((await pdfInfo(await organize(p1001, { order: [1000, 0] }))).pages, 2);
  // results above the limit fail
  await expectCode(merge([{ bytes: p1001 }]), 'TOO_MANY_PAGES');
  const p600 = await fx.plainPdf(600);
  await expectCode(merge([{ bytes: p600 }, { bytes: p600 }]), 'TOO_MANY_PAGES');
  // split: overlapping parts are fine while each part <= MAX_PAGES and total <= MAX_SPLIT_TOTAL_PAGES
  assert.deepEqual((await split(p600, '1-600,1-401')).map((p) => p.pages.length), [600, 401]);
  await expectCode(organize(p1001, { order: [...Array(1001).keys()] }), 'TOO_MANY_PAGES');
  await expectCode(organize(await fx.plainPdf(1), { order: Array(1001).fill(0) }), 'TOO_MANY_PAGES'); // duplicates count
  assert.equal((await pdfInfo(await organize(await fx.plainPdf(1), { order: Array(1000).fill(0) }))).pages, 1000);
  // exactly at the limit is fine
  assert.equal((await pdfInfo(await merge([{ bytes: p600 }, { bytes: p600, pages: '1-400' }]))).pages, 1000);
});

test('split: MAX_PAGES applies to each part, not to the sum of parts', async () => {
  const p2000 = await fx.plainPdf(2000);
  const parts = await split(p2000, '1-1000,1001-2000');
  assert.deepEqual(parts.map((p) => p.pages.length), [1000, 1000]);
  assert.deepEqual(await Promise.all(parts.map(async (p) => (await pdfInfo(p.bytes)).pages)), [1000, 1000]);
  assert.equal(parts[1].pages[0], 1001);
  const pairs = await split(p2000, [[1, 1000], [1001, 2000]]);
  assert.deepEqual(pairs.map((p) => p.pages.length), [1000, 1000]);
  assert.equal((await split(p2000, [[1, 500], [1000, 1501]])).length, 2);
  let e = await expectCode(split(p2000, '1-1001'), 'TOO_MANY_PAGES');
  assert.deepEqual(e.details, { limit: 'part', max: 1000, part: 0, pages: 1001 });
  e = await expectCode(split(p2000, [[1, 10], [500, 1500]]), 'TOO_MANY_PAGES');
  assert.deepEqual(e.details, { limit: 'part', max: 1000, part: 1, pages: 1001 });
});

test('split: all parts together <= MAX_SPLIT_TOTAL_PAGES (5000), checked fast before copying', async () => {
  const p1000 = await fx.plainPdf(1000);
  const five = await split(p1000, Array(5).fill('1-1000').join(','));
  assert.equal(five.length, 5);
  let t0 = Date.now();
  let e = await expectCode(split(p1000, Array(6).fill('1-1000').join(',')), 'TOO_MANY_PAGES');
  assert.deepEqual(e.details, { limit: 'total', max: 5000, total: 6000 });
  // a long repeated spec stops at the limit, long before building or copying anything
  e = await expectCode(split(p1000, Array(1400).fill('1-1000').join(',')), 'TOO_MANY_PAGES');
  assert.deepEqual(e.details, { limit: 'total', max: 5000, total: 6000 });
  e = await expectCode(split(p1000, Array(1000).fill([1, 1000])), 'TOO_MANY_PAGES');
  assert.deepEqual(e.details, { limit: 'total', max: 5000, total: 6000 });
  e = await expectCode(split(p1000, '1-1000,1-1000,1-1000,1-1000,1-999,1-2'), 'TOO_MANY_PAGES');
  assert.deepEqual(e.details, { limit: 'total', max: 5000, total: 5001 });
  assert.ok(Date.now() - t0 < 2000, 'fails fast (page loading dominates)');
});

test('split: at most MAX_SPLIT_PARTS (50) parts -> TOO_MANY_FILES', async () => {
  const p60 = await fx.plainPdf(60);
  const spec = (n) => Array.from({ length: n }, (_, k) => String(k + 1)).join(',');
  assert.equal((await split(p60, spec(50))).length, 50);
  let e = await expectCode(split(p60, spec(51)), 'TOO_MANY_FILES');
  assert.deepEqual(e.details, { limit: 'parts', max: 50, parts: 51 });
  e = await expectCode(split(p60, Array.from({ length: 51 }, (_, k) => [k + 1, k + 1])), 'TOO_MANY_FILES');
  assert.deepEqual(e.details, { limit: 'parts', max: 50, parts: 51 });
});

test('split: reversed ranges -> PAGE_RANGE; open ranges valid', async () => {
  const p10 = await fx.plainPdf(10);
  let e = await expectCode(split(p10, '5-3'), 'PAGE_RANGE');
  assert.deepEqual(e.details, { from: 5, to: 3 });
  e = await expectCode(split(p10, [[5, 3]]), 'PAGE_RANGE');
  assert.deepEqual(e.details, { from: 5, to: 3 });
  const parts = await split(p10, '-3,5-,-1');
  assert.deepEqual(parts.map((p) => p.pages), [[1, 2, 3], [5, 6, 7, 8, 9, 10], [1]]);
});
