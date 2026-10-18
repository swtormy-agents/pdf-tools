import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { imagesToPdf, jpegSize, pngSize, stripJpeg, stripPng, jpegOrientation, orientationMatrix, LIMITS } from '../src/index.js';
import * as fx from './fixtures/gen.mjs';
import { expectCode, assertClean, latin1 } from './helpers.mjs';

const has = (hay, needle) => Buffer.from(hay).includes(Buffer.from(needle));

async function imageStreams(pdfBytes) {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const out = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) out.push(obj);
  }
  return { doc, streams: out };
}

async function contentText(page) {
  const c = page.node.Contents();
  const streams = c.asArray ? c.asArray().map((r) => page.doc.context.lookup(r)) : [c];
  return streams.map((s) => {
    const f = s.dict.get(PDFName.of('Filter'));
    return latin1(f === PDFName.of('FlateDecode') ? inflateSync(s.contents) : s.contents);
  }).join('\n');
}

test('header parsers', () => {
  assert.deepEqual(jpegSize(fx.plainJpeg()), { width: 24, height: 16 });
  assert.deepEqual(jpegSize(fx.exifJpeg()), { width: 24, height: 16 });
  assert.deepEqual(jpegSize(fx.jpegWithSize(10000, 10000)), { width: 10000, height: 10000 });
  assert.deepEqual(pngSize(fx.plainPng(8, 5)), { width: 8, height: 5 });
  assert.deepEqual(pngSize(fx.pngWithSize(10000, 10000)), { width: 10000, height: 10000 });
});

test('EXIF orientation is read (big- and little-endian), default 1', () => {
  for (let o = 1; o <= 8; o++) {
    assert.equal(jpegOrientation(fx.orientedJpeg(o)), o);
    assert.equal(jpegOrientation(fx.orientedJpeg(o, true)), o);
  }
  assert.equal(jpegOrientation(fx.plainJpeg()), 1);
  assert.equal(jpegOrientation(fx.exifJpeg()), 1); // EXIF without orientation tag
  assert.equal(jpegOrientation(fx.orientedJpeg(9)), 1); // invalid value
  assert.equal(jpegOrientation(fx.corruptBytes(64)), 1);
});

test('pdf-lib alone WOULD carry EXIF/GPS (reason for stripping)', async () => {
  const doc = await PDFDocument.create();
  await doc.embedJpg(fx.exifJpeg());
  const raw = await doc.save({ useObjectStreams: false });
  assert.ok(has(raw, 'EVIL-EXIF-DESC'));
  assert.ok(has(raw, fx.gpsRationalBytes()));
});

test('JPEG: EXIF/GPS, XMP, IPTC, MPF, COM, trailer stripped without re-encoding', async () => {
  const src = fx.exifJpeg({ orientation: 1 });
  const stripped = stripJpeg(src);
  for (const s of ['Exif', 'EVIL', 'Photoshop', 'MPF', 'xmpmeta']) assert.ok(!has(stripped, s), s);
  assert.ok(!has(stripped, fx.gpsRationalBytes()));
  // entropy-coded data and tables identical to the clean original => no re-encoding
  assert.deepEqual(Buffer.from(stripped), Buffer.from(fx.plainJpeg()));

  const pdf = await imagesToPdf([{ bytes: src }]);
  await assertClean(pdf);
  assert.ok(!has(pdf, 'Exif'));
  assert.ok(!has(pdf, fx.gpsRationalBytes()));
  const { doc, streams } = await imageStreams(pdf);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].dict.get(PDFName.of('Filter')), PDFName.of('DCTDecode'));
  assert.deepEqual(Buffer.from(streams[0].contents), Buffer.from(fx.plainJpeg()));
  const page = doc.getPage(0);
  assert.deepEqual([page.getWidth(), page.getHeight()], [24, 16]);
});

test('JPEG: APP2 ICC_PROFILE and APP14 Adobe are kept, EXIF removed', async () => {
  const pdf = await imagesToPdf([{ bytes: fx.iccAdobeJpeg() }]);
  const { streams } = await imageStreams(pdf);
  const data = streams[0].contents;
  assert.ok(has(data, 'ICC_PROFILE\0'));
  assert.ok(has(data, fx.KEEP_ICC_MARKER));
  assert.ok(has(data, Uint8Array.of(0xff, 0xee)));
  assert.ok(has(data, fx.KEEP_ADOBE_MARKER));
  assert.ok(!has(data, 'Exif'));
  assert.ok(!has(data, 'EVIL'));
});

test('EXIF orientation 1..8 applied: page size and content matrix', async () => {
  const W = 24, H = 16;
  const expected = {
    1: [W, H, [W, 0, 0, H, 0, 0]],
    2: [W, H, [-W, 0, 0, H, W, 0]],
    3: [W, H, [-W, 0, 0, -H, W, H]],
    4: [W, H, [W, 0, 0, -H, 0, H]],
    5: [H, W, [0, -W, -H, 0, H, W]],
    6: [H, W, [0, -W, H, 0, 0, W]],
    7: [H, W, [0, W, H, 0, 0, 0]],
    8: [H, W, [0, W, -H, 0, H, 0]],
  };
  for (let o = 1; o <= 8; o++) {
    const pdf = await imagesToPdf([{ bytes: fx.orientedJpeg(o) }]);
    await assertClean(pdf);
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    const page = doc.getPage(0);
    const [pw, ph, m] = expected[o];
    assert.deepEqual([page.getWidth(), page.getHeight()], [pw, ph], `orientation ${o} page size`);
    assert.deepEqual(orientationMatrix(o, W, H), m);
    const text = await contentText(page);
    assert.ok(text.includes(`${m.join(' ')} cm`), `orientation ${o} matrix in content: ${text}`);
    // the matrix maps the unit square exactly onto the page
    const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]);
    assert.deepEqual([Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))], [0, pw]);
    assert.deepEqual([Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))], [0, ph]);
    assert.ok(!has(pdf, 'Exif'));
  }
});

test('PNG: tEXt/iTXt/zTXt/eXIf/tIME do not reach the output', async () => {
  const src = fx.metadataPng();
  for (const t of ['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME']) assert.ok(has(src, t));
  const stripped = stripPng(src);
  for (const t of ['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME', 'EVIL']) assert.ok(!has(stripped, t), t);
  assert.deepEqual(pngSize(stripped), { width: 8, height: 8 });

  const pdf = await imagesToPdf([{ bytes: src }]);
  const { text } = await assertClean(pdf); // inflates all streams, searches for EVIL markers
  for (const t of ['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME']) assert.ok(!text.includes(t), t);
  const { doc, streams } = await imageStreams(pdf);
  assert.equal(streams.length, 1);
  assert.deepEqual([doc.getPage(0).getWidth(), doc.getPage(0).getHeight()], [8, 8]);
  // pdf-lib also drops the chunks by itself (decode + re-encode); verify without our strip
  const raw = await PDFDocument.create();
  await raw.embedPng(src);
  const { text: rawText } = await (await import('./helpers.mjs')).dump(await raw.save());
  assert.ok(!rawText.includes('EVIL'));
});

test('format auto-detected from magic bytes; type field ignored', async () => {
  const pdf = await imagesToPdf([{ bytes: fx.plainJpeg(), type: 'png' }, { bytes: fx.plainPng(10, 6) }, { bytes: fx.plainPng(), type: 'gif' }]);
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  assert.deepEqual(doc.getPages().map((p) => [p.getWidth(), p.getHeight()]), [[24, 16], [10, 6], [8, 8]]);
  await assertClean(pdf);
});

test('oversized images rejected from header before decoding', async () => {
  const t0 = Date.now();
  const e1 = await expectCode(imagesToPdf([{ bytes: fx.plainPng() }, { bytes: fx.pngWithSize(10000, 10000) }]), 'IMAGE_TOO_LARGE');
  assert.equal(e1.details.index, 1);
  assert.equal(e1.details.width, 10000);
  await expectCode(imagesToPdf([{ bytes: fx.jpegWithSize(10000, 10000) }]), 'IMAGE_TOO_LARGE');
  await expectCode(imagesToPdf([{ bytes: fx.pngWithSize(7072, 7071) }]), 'IMAGE_TOO_LARGE'); // 50,006,112 px
  assert.ok(Date.now() - t0 < 2000, 'no decoding happened');
  assert.ok(7071 * 7071 <= LIMITS.MAX_IMAGE_PIXELS);
});

test('unsupported vs invalid images', async () => {
  const gif = new TextEncoder().encode('GIF89a\x01\x00\x01\x00');
  await expectCode(imagesToPdf([{ bytes: gif }]), 'UNSUPPORTED_IMAGE');
  await expectCode(imagesToPdf([{ bytes: await fx.plainPdf(1) }]), 'UNSUPPORTED_IMAGE');
  await expectCode(imagesToPdf([{ bytes: new Uint8Array(0) }]), 'UNSUPPORTED_IMAGE');
  const badJpeg = new Uint8Array([0xff, 0xd8, 0xff, ...fx.corruptBytes(100)]);
  const e = await expectCode(imagesToPdf([{ bytes: fx.plainPng() }, { bytes: badJpeg }]), 'IMAGE_INVALID');
  assert.equal(e.details.index, 1);
  const pngSig = fx.plainPng().subarray(0, 8);
  await expectCode(imagesToPdf([{ bytes: new Uint8Array([...pngSig, ...fx.corruptBytes(40)]) }]), 'IMAGE_INVALID');
  const brokenIdat = fx.pngWithSize(100, 100).slice();
  const at = Buffer.from(brokenIdat).indexOf('IDAT') + 4;
  brokenIdat.fill(0xff, at, at + 8); // header ok, zlib data broken
  await expectCode(imagesToPdf([{ bytes: brokenIdat }]), 'IMAGE_INVALID');
  await expectCode(imagesToPdf([{ bytes: fx.pngWithSize(0, 10) }]), 'IMAGE_INVALID');
  await expectCode(imagesToPdf([]), 'PDF_INVALID');
  await expectCode(imagesToPdf([{ bytes: 'x' }]), 'PDF_INVALID');
});

test('pageSize/margin: default output is unchanged (fit, no margin)', async () => {
  const list = [{ bytes: fx.orientedJpeg(6) }, { bytes: fx.plainPng(8, 8) }];
  const a = await imagesToPdf(list);
  assert.deepEqual(Buffer.from(await imagesToPdf(list, {})), Buffer.from(a));
  assert.deepEqual(Buffer.from(await imagesToPdf(list, { pageSize: 'fit', margin: 0 })), Buffer.from(a));
});

test('pageSize A4/Letter: portrait page, image scaled to fit inside margin, aspect kept, centered', async () => {
  const W = 24, H = 16;
  const cases = [
    // [pageSize, margin, orientation, pageW, pageH]
    ['A4', 0, 1, 595.28, 841.89],
    ['A4', 36, 1, 595.28, 841.89],
    ['Letter', 0, 1, 612, 792],
    ['Letter', 72, 6, 612, 792],
    ['A4', 10, 8, 595.28, 841.89],
  ];
  for (const [pageSize, margin, o, PW, PH] of cases) {
    const pdf = await imagesToPdf([{ bytes: fx.orientedJpeg(o) }], { pageSize, margin });
    await assertClean(pdf);
    const page = (await PDFDocument.load(pdf, { updateMetadata: false })).getPage(0);
    assert.deepEqual([page.getWidth(), page.getHeight()], [PW, PH], `${pageSize} page size`);
    const dw = o >= 5 ? H : W;
    const dh = o >= 5 ? W : H;
    const s = Math.min((PW - 2 * margin) / dw, (PH - 2 * margin) / dh);
    const x = (PW - dw * s) / 2;
    const y = (PH - dh * s) / 2;
    // compose translate(x, y) with the orientation matrix and map the unit square
    const m = orientationMatrix(o, W * s, H * s);
    const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [m[0] * u + m[2] * v + m[4] + x, m[1] * u + m[3] * v + m[5] + y]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const close = (a, b) => Math.abs(a - b) < 1e-6;
    // fills the content box along one axis, centered along both
    assert.ok(close(Math.min(...xs), PW - Math.max(...xs)) && close(Math.min(...ys), PH - Math.max(...ys)), 'centered');
    assert.ok(close(Math.min(...xs), margin) || close(Math.min(...ys), margin), 'touches the margin on one axis');
    assert.ok(Math.min(...xs) >= margin - 1e-6 && Math.min(...ys) >= margin - 1e-6, 'inside margins');
    assert.ok(close((Math.max(...xs) - Math.min(...xs)) / (Math.max(...ys) - Math.min(...ys)), dw / dh), 'aspect ratio kept');
    const text = await contentText(page);
    assert.ok(text.includes(`1 0 0 1 ${x} ${y} cm`), `translation in content: ${text}`);
    assert.ok(!has(pdf, 'Exif'));
  }
});

test('margin with pageSize fit grows the page by 2 * margin', async () => {
  const pdf = await imagesToPdf([{ bytes: fx.plainJpeg() }], { margin: 10 });
  const page = (await PDFDocument.load(pdf, { updateMetadata: false })).getPage(0);
  assert.deepEqual([page.getWidth(), page.getHeight()], [44, 36]);
  assert.ok((await contentText(page)).includes('1 0 0 1 10 10 cm'));
});

test('invalid imagesToPdf options -> PDF_INVALID', async () => {
  const list = [{ bytes: fx.plainJpeg() }];
  for (const options of ['A4', [], { pageSize: 'a4' }, { pageSize: 'Legal' }, { pageSize: 'toString' }, { margin: -1 },
    { margin: '10' }, { margin: NaN }, { margin: Infinity }, { pageSize: 'A4', margin: 297.64 }, { pageSize: 'Letter', margin: 306 },
    { margin: 3600 }]) {
    const e = await expectCode(imagesToPdf(list, options), 'PDF_INVALID');
    assert.ok(!e.message.includes('undefined'));
  }
});
