// Regression tests for the QA review of 331a28a: blockers 1-4 and the
// object-stream decompression bomb. All fixtures are built here, at test time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFString, PDFRawStream, PDFDict, PDFArray } from 'pdf-lib';
import { merge, split, organize, pdfInfo, stripJpeg, LIMITS } from '../src/index.js';
import * as fx from '../test/fixtures/gen.mjs';
import { expectCode, assertClean, latin1, deflateBombRepeated, objStmBombPdf as objStmBombPdfZ } from './helpers.mjs';

const objStmBombPdf = (n, z = deflateBomb(n)) => objStmBombPdfZ(z);

const has = (bytes, needle) => Buffer.from(bytes).includes(typeof needle === 'string' ? Buffer.from(needle, 'latin1') : Buffer.from(needle));

// Synthetic, distinctive, non-zero location (12°34'56.789" N, 65°7'6.543" E, open Arabian Sea) so
// absence checks are meaningful: these rational bytes cannot occur by chance.
const GPS = [...fx.GPS_RATIONALS];
const GPS_LAT = fx.gpsRationalBytes(false, GPS.slice(0, 6));
const GPS_LON = fx.gpsRationalBytes(false, GPS.slice(6));

/** Run all three page-copying operations on `bytes`, return every output. */
async function allOutputs(bytes) {
  const outs = [await merge([{ bytes }]), ...(await split(bytes, '1')).map((p) => p.bytes), await organize(bytes, { order: [0, 0] })];
  for (const o of outs) await assertClean(o);
  return outs;
}

async function imageStreamsOf(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const out = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) out.push(obj);
  }
  return out;
}

function imageDict(ctx, w, h, extra = {}) {
  return { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, ...extra };
}

/** One page drawing the given XObjects (name -> ref). */
async function pageWith(build) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const ctx = doc.context;
  const xobjs = build(doc, page, ctx) || {};
  const names = Object.keys(xobjs);
  for (const n of names) page.node.setXObject(PDFName.of(n), xobjs[n]);
  const ops = names.map((n) => `q 24 0 0 16 10 10 cm /${n} Do Q`).join('\n');
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(ops)));
  return doc.save({ useObjectStreams: false });
}

test('GPS canary: non-zero synthetic coordinates really are in the source JPEG and pdf-lib would carry them', async () => {
  const jpg = fx.exifJpeg({ gpsRationals: GPS });
  assert.ok(has(jpg, GPS_LAT) && has(jpg, GPS_LON));
  const doc = await PDFDocument.create();
  await doc.embedJpg(jpg);
  const raw = await doc.save({ useObjectStreams: false });
  assert.ok(has(raw, GPS_LAT), 'canary must be visible without stripping');
  const stripped = stripJpeg(jpg);
  assert.ok(!has(stripped, GPS_LAT) && !has(stripped, GPS_LON) && !has(stripped, 'Exif'));
});

test('blocker 1: DCTDecode images inside input PDFs lose EXIF/GPS/XMP/IPTC/COM on merge/split/organize (no re-encode)', async () => {
  const jpg = fx.exifJpeg({ gpsRationals: GPS, orientation: 6 });
  const src = await pageWith((doc, page, ctx) => {
    const img = ctx.register(ctx.stream(jpg, imageDict(ctx, 24, 16, { Filter: 'DCTDecode' })));
    const img2 = ctx.register(ctx.stream(jpg, imageDict(ctx, 24, 16, { Filter: ['DCTDecode'] })));
    return { Im1: img, Im2: img2 };
  });
  assert.ok(has(src, GPS_LAT) && has(src, 'EVIL-IPTC'), 'fixture carries the metadata');
  for (const out of await allOutputs(src)) {
    for (const bad of [GPS_LAT, GPS_LON, 'Exif', 'EVIL', 'xmpmeta', 'Photoshop', 'MPF']) assert.ok(!has(out, bad), String(bad));
    const imgs = await imageStreamsOf(out);
    assert.equal(imgs.length, 2);
    for (const s of imgs) {
      assert.equal(s.dict.get(PDFName.of('Filter')), PDFName.of('DCTDecode'));
      assert.deepEqual(Buffer.from(s.contents), Buffer.from(fx.plainJpeg()), 'entropy-coded data unchanged');
    }
  }
});

test('blocker 1: ICC APP2 and Adobe APP14 survive; Flate+DCT chain is decoded to a pure DCTDecode stream', async () => {
  const icc = fx.iccAdobeJpeg();
  const exif = fx.exifJpeg({ gpsRationals: GPS });
  const src = await pageWith((doc, page, ctx) => ({
    Icc: ctx.register(ctx.stream(icc, imageDict(ctx, 24, 16, { Filter: 'DCTDecode' }))),
    Chain: ctx.register(ctx.stream(deflateSync(exif), imageDict(ctx, 24, 16, { Filter: ['FlateDecode', 'DCTDecode'] }))),
  }));
  for (const out of await allOutputs(src)) {
    assert.ok(!has(out, GPS_LAT) && !has(out, 'Exif'));
    const imgs = await imageStreamsOf(out);
    const bytes = imgs.map((s) => Buffer.from(s.contents));
    for (const s of imgs) assert.equal(s.dict.get(PDFName.of('Filter')), PDFName.of('DCTDecode'));
    assert.ok(bytes.some((b) => b.includes(fx.KEEP_ICC_MARKER) && b.includes(fx.KEEP_ADOBE_MARKER)), 'ICC + Adobe kept');
    assert.ok(bytes.some((b) => b.equals(Buffer.from(stripJpeg(exif)))), 'chained JPEG stripped');
    assert.ok(bytes.every((b) => !b.includes('Exif')));
  }
});

test('blocker 1: JPEG that cannot be sanitized fails closed (PDF_INVALID), never copied with metadata', async () => {
  const bad = await pageWith((doc, page, ctx) => ({
    Im: ctx.register(ctx.stream(Buffer.concat([Buffer.from(fx.exifJpeg({ gpsRationals: GPS }).subarray(0, 40)), Buffer.from('garbage')]),
      imageDict(ctx, 24, 16, { Filter: 'DCTDecode' }))),
  }));
  await expectCode(merge([{ bytes: bad }]), 'PDF_INVALID');
  const chain = await pageWith((doc, page, ctx) => ({
    Im: ctx.register(ctx.stream(fx.exifJpeg(), imageDict(ctx, 24, 16, { Filter: ['DCTDecode', 'FlateDecode'] }))),
  }));
  await expectCode(split(chain, '1'), 'PDF_INVALID');
});

test('blocker 2: /Metadata and /PieceInfo on image and form XObjects (also nested in form Resources) are removed', async () => {
  const src = await pageWith((doc, page, ctx) => {
    const xmp = (who) => ctx.register(ctx.stream(`<x:xmpmeta><dc:creator>EVIL-${who}</dc:creator></x:xmpmeta>`, { Type: 'Metadata', Subtype: 'XML' }));
    const piece = ctx.obj({ EVILApp: { LastModified: PDFString.of('EVIL-PIECE'), Private: PDFString.of('EVIL-PIECE-DATA') } });
    const img = ctx.register(ctx.stream(fx.plainJpeg(), imageDict(ctx, 24, 16, { Filter: 'DCTDecode', Metadata: xmp('IMG-XMP-AUTHOR') })));
    const inner = ctx.register(ctx.stream('/Im0 Do', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Metadata: xmp('INNER-FORM-XMP'), PieceInfo: piece,
      Resources: { XObject: { Im0: img } },
    }));
    const form = ctx.register(ctx.stream('/Fx0 Do', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Metadata: xmp('FORM-XMP'), PieceInfo: piece,
      Resources: { XObject: { Fx0: inner } },
    }));
    const pattern = ctx.register(ctx.stream('0 0 1 1 re f', {
      PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 1, 1], XStep: 1, YStep: 1,
      Metadata: xmp('PATTERN-XMP'), Resources: { XObject: { Fx: form } },
    }));
    page.node.normalizedEntries();
    page.node.Resources().set(PDFName.of('Pattern'), ctx.obj({ P0: pattern }));
    return { Im: img, Fm: form };
  });
  assert.ok(has(src, 'EVIL-IMG-XMP-AUTHOR') && has(src, 'EVIL-PIECE'));
  for (const out of await allOutputs(src)) {
    for (const bad of ['EVIL', '/Metadata', '/PieceInfo', 'xmpmeta']) assert.ok(!has(out, bad), bad);
    assert.equal((await imageStreamsOf(out)).length, 1, 'image itself is kept');
  }
});

test('blocker 3: embedded files via page /AF and /AF in resources are removed', async () => {
  const src = await pageWith((doc, page, ctx) => {
    const ef = ctx.register(ctx.stream('EVIL-AF-CONTENT', { Type: 'EmbeddedFile', Subtype: 'text#2Fplain' }));
    const fs = ctx.register(ctx.obj({ Type: 'Filespec', F: PDFString.of('EVIL-AF.txt'), UF: PDFString.of('EVIL-AF.txt'), AFRelationship: 'Data', EF: { F: ef, UF: ef } }));
    const fsNoType = ctx.register(ctx.obj({ F: PDFString.of('EVIL-AF2.txt'), EF: { F: ef } }));
    page.node.set(PDFName.of('AF'), ctx.obj([fs]));
    const form = ctx.register(ctx.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], AF: [fsNoType] }));
    page.node.normalizedEntries();
    page.node.Resources().set(PDFName.of('ExtGState'), ctx.obj({ G0: { Type: 'ExtGState', CA: 1, AF: [fs], Private: fsNoType } }));
    return { Fm: form };
  });
  assert.ok(has(src, 'EVIL-AF-CONTENT'));
  for (const out of await allOutputs(src)) {
    for (const bad of ['EVIL', '/AF', '/EmbeddedFile', '/Filespec', '/EF']) assert.ok(!has(out, bad), bad);
  }
});

test('blocker 4: JS/Launch under non-standard page keys and in /Resources are removed; page keys allowlisted', async () => {
  const src = await pageWith((doc, page, ctx) => {
    const js = (s) => ctx.obj({ S: 'JavaScript', JS: PDFString.of(`app.alert("${s}")`) });
    const launch = ctx.obj({ S: 'Launch', F: PDFString.of('EVIL-LAUNCH.exe') });
    page.node.set(PDFName.of('LeakJS'), ctx.register(js('EVIL-PAGE-PRIVKEY')));
    page.node.set(PDFName.of('LeakLaunch'), launch);
    page.node.set(PDFName.of('LeakArr'), ctx.obj([js('EVIL-PAGE-ARR')]));
    page.node.set(PDFName.of('StructParents'), ctx.obj(3));
    page.node.set(PDFName.of('Group'), ctx.obj({ Type: 'Group', S: 'Transparency', CS: 'DeviceRGB', EVILKey: js('EVIL-GROUP') }));
    page.node.normalizedEntries();
    const res = page.node.Resources();
    res.set(PDFName.of('Properties'), ctx.obj({ P1: js('EVIL-PROPERTIES'), P2: { Type: 'OCG', Name: PDFString.of('x'), A: launch } }));
    res.set(PDFName.of('LeakRes'), ctx.register(js('EVIL-RES-PRIVKEY')));
    res.set(PDFName.of('ExtGState'), ctx.obj({ G0: { Type: 'ExtGState', ca: 0.5, LeakJS: js('EVIL-GS') }, G1: launch }));
    res.set(PDFName.of('Font'), ctx.obj({ F1: { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', AA: { O: js('EVIL-FONT-AA') } } }));
    const form = ctx.register(ctx.stream('', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], OpenAction: js('EVIL-FORM-OA'),
      Resources: { Properties: { X: js('EVIL-FORM-PROPS') }, LeakRes: launch },
    }));
    return { Fm: form, Leak: ctx.register(js('EVIL-XOBJECT-ENTRY')) };
  });
  assert.ok(has(src, 'EVIL-PAGE-PRIVKEY') && has(src, 'EVIL-PROPERTIES'));
  const allowed = new Set(['/Type', '/Resources', '/MediaBox', '/CropBox', '/BleedBox', '/TrimBox', '/ArtBox', '/Contents',
    '/Rotate', '/Annots', '/UserUnit', '/Group', '/Parent']);
  for (const out of await allOutputs(src)) {
    for (const bad of ['EVIL', '/JavaScript', '/JS', '/Launch', '/Properties', '/LeakRes', '/LeakJS', '/OpenAction', '/StructParents']) {
      assert.ok(!has(out, bad), bad);
    }
    const doc = await PDFDocument.load(out, { updateMetadata: false });
    for (const p of doc.getPages()) {
      for (const k of p.node.keys()) assert.ok(allowed.has(k.asString()), `page key ${k}`);
      const res = p.node.Resources();
      for (const k of res.keys()) assert.ok(['/Font', '/XObject', '/ExtGState', '/ColorSpace', '/Pattern', '/Shading', '/ProcSet'].includes(k.asString()), `res key ${k}`);
      const group = p.node.lookup(PDFName.of('Group'), PDFDict);
      assert.equal(group.get(PDFName.of('S')), PDFName.of('Transparency'), 'legit /S of a group is kept');
      assert.ok(res.lookup(PDFName.of('Font'), PDFDict).has(PDFName.of('F1')), 'font kept');
      const gs = res.lookup(PDFName.of('ExtGState'), PDFDict);
      assert.ok(gs.has(PDFName.of('G0')) && !gs.has(PDFName.of('G1')));
    }
  }
});

test('blocker 2-4: resources inherited from the /Pages node are sanitized too', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  const ctx = doc.context;
  const pages = doc.catalog.lookup(PDFName.of('Pages'), PDFDict);
  pages.set(PDFName.of('Resources'), ctx.obj({
    Properties: { P: { S: 'JavaScript', JS: PDFString.of('EVIL-INHERITED') } },
    XObject: { Im: ctx.register(ctx.stream(fx.exifJpeg({ gpsRationals: GPS }), imageDict(ctx, 24, 16, { Filter: 'DCTDecode' }))) },
  }));
  page.node.delete(PDFName.of('Resources'));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('q 24 0 0 16 0 0 cm /Im Do Q')));
  const src = await doc.save({ useObjectStreams: false });
  for (const out of await allOutputs(src)) {
    assert.ok(!has(out, 'EVIL') && !has(out, GPS_LAT) && !has(out, '/Properties'));
    assert.equal((await imageStreamsOf(out)).length, 1);
  }
});

test('sanitizing keeps ordinary content: text, fonts, links, object streams', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  page.drawText('Hello KEEP', { x: 10, y: 10, size: 12 });
  await doc.embedJpg(fx.plainJpeg()).then((img) => page.drawImage(img, { x: 50, y: 50, width: 24, height: 16 }));
  const src = await doc.save({ useObjectStreams: true });
  const out = await merge([{ bytes: src }]);
  const d = await PDFDocument.load(out);
  const res = d.getPage(0).node.Resources();
  assert.ok(res.lookup(PDFName.of('Font'), PDFDict).keys().length === 1);
  assert.ok(res.lookup(PDFName.of('XObject'), PDFDict).keys().length === 1);
  assert.equal((await pdfInfo(src)).pages, 1);
});

// --- decompression cap -------------------------------------------------------------

/** Raw deflate stream inflating to `n` spaces, built directly (no n-byte buffer). */
function deflateBomb(n) {
  const out = [];
  let acc = 0;
  let bits = 0;
  const put = (v, len) => { // LSB-first
    acc |= v << bits; bits += len;
    while (bits >= 8) { out.push(acc & 0xff); acc >>>= 8; bits -= 8; }
  };
  const putRev = (code, len) => { // Huffman codes are stored MSB-first
    let r = 0;
    for (let k = 0; k < len; k++) r |= ((code >> k) & 1) << (len - 1 - k);
    put(r, len);
  };
  put(1, 1); put(1, 2); // BFINAL, fixed Huffman
  putRev(0x30 + 0x20, 8); // literal ' ' (0x20): codes 0-143 = 0x30 + v, 8 bits
  let left = n - 1;
  while (left >= 258) { putRev(0xc5, 8); putRev(0, 5); left -= 258; } // length 258 (code 285), distance 1
  while (left-- > 0) putRev(0x30 + 0x20, 8);
  putRev(0, 7); // end of block (256)
  if (bits) put(0, 8 - bits);
  return Buffer.concat([Buffer.from([0x78, 0x01]), Buffer.from(out), Buffer.alloc(4)]);
}

test('limits: MAX_DECOMPRESSED_BYTES is 500 MiB', () => {
  assert.equal(LIMITS.MAX_DECOMPRESSED_BYTES, 500 * 1024 * 1024);
});

test('decompression bomb in /ObjStm -> TOO_LARGE {reason: decompressed} fast, without allocating GBs', async () => {
  const bytes = objStmBombPdf(1024 * 1024 * 1024); // 1 GiB of spaces in a ~6.6 MB file
  assert.ok(bytes.length < 8 * 1024 * 1024);
  const rss0 = process.memoryUsage().rss;
  const t0 = Date.now();
  for (const run of [() => pdfInfo(bytes), () => merge([{ bytes }]), () => split(bytes, '1'), () => organize(bytes, { order: [0] })]) {
    const e = await expectCode(run, 'TOO_LARGE');
    assert.deepEqual(e.details, { reason: 'decompressed', limit: LIMITS.MAX_DECOMPRESSED_BYTES });
  }
  const ms = Date.now() - t0;
  const grew = (process.memoryUsage().rss - rss0) / 1048576;
  assert.ok(ms < 60_000, `took ${ms} ms`);
  assert.ok(grew < 400, `rss grew by ${grew.toFixed(0)} MiB`);
});

test('decompression cap is per call over all inputs; below it object streams work', async () => {
  const ok = objStmBombPdf(1024 * 1024); // 1 MiB of spaces: harmless
  assert.equal((await pdfInfo(ok)).pages, 1);
  const half = objStmBombPdf(300 * 1024 * 1024);
  assert.equal((await pdfInfo(half)).pages, 1); // 300 MiB alone fits
  const e = await expectCode(merge([{ bytes: half }, { bytes: half }]), 'TOO_LARGE'); // 600 MiB together
  assert.equal(e.details.reason, 'decompressed');
});

test('QA MCP case: /ObjStm inflating to 6.2 GB is capped while PARSING -> TOO_LARGE fast, no full allocation', async () => {
  const n = 6.2e9;
  const z = deflateBombRepeated(n);
  // sanity: the stream really inflates past the cap (first 600 MiB checked by streaming inflate, then aborted)
  const { default: pako } = await import('pako');
  let seen = 0;
  const inf = new pako.Inflate({ chunkSize: 1 << 20 });
  inf.onData = (c) => { seen += c.length; if (seen > 600 * 1024 * 1024) throw new Error('enough'); };
  assert.throws(() => inf.push(z.subarray(0, 4 * 1024 * 1024), false), /enough/);
  const bytes = objStmBombPdf(0, z);
  assert.ok(bytes.length < 45 * 1024 * 1024, `fixture ${bytes.length} bytes`);
  const rss0 = process.memoryUsage().rss;
  const t0 = Date.now();
  for (const run of [() => pdfInfo(bytes), () => merge([{ bytes }]), () => split(bytes, '1'), () => organize(bytes, { order: [0] })]) {
    const e = await expectCode(run, 'TOO_LARGE');
    assert.deepEqual(e.details, { reason: 'decompressed', limit: LIMITS.MAX_DECOMPRESSED_BYTES });
  }
  const ms = Date.now() - t0;
  const grew = (process.memoryUsage().rss - rss0) / 1048576;
  assert.ok(ms < 60_000, `took ${ms} ms`);
  assert.ok(grew < 400, `rss grew by ${grew.toFixed(0)} MiB (6.2 GB were never allocated)`);
});
