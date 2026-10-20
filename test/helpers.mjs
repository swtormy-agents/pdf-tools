import { inflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFRawStream, PDFDict, PDFArray, PDFHexString, PDFString } from 'pdf-lib';

export const latin1 = (b) => Buffer.from(b.buffer, b.byteOffset, b.length).toString('latin1');

/** Decoded text of every object in a PDF (object streams expanded, Flate streams inflated, hex strings decoded). */
export async function dump(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const parts = [];
  const walk = (o) => {
    if (o instanceof PDFHexString || o instanceof PDFString) parts.push(o.decodeText());
    else if (o instanceof PDFDict) for (const [, v] of o.entries()) walk(v);
    else if (o instanceof PDFArray) for (const v of o.asArray()) walk(v);
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      parts.push(obj.dict.toString());
      walk(obj.dict);
      const filter = obj.dict.get(PDFName.of('Filter'));
      let data = obj.contents;
      if (filter === PDFName.of('FlateDecode')) {
        try { data = inflateSync(data); } catch { /* keep raw */ }
      }
      parts.push(latin1(data));
    } else {
      parts.push(obj.toString());
      walk(obj);
    }
  }
  parts.push(String(doc.context.trailerInfo.Info ?? ''));
  return { doc, text: parts.join('\n') };
}

export async function expectCode(promiseOrFn, code) {
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
  } catch (e) {
    assert.equal(e.name, 'PdfToolError', `expected PdfToolError, got ${e && e.stack}`);
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return e;
  }
  assert.fail(`expected PdfToolError ${code}, nothing thrown`);
}

export async function pageWidths(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((p) => Math.round(p.getWidth()));
}

/** Structural checks that every core output must pass. */
export async function assertClean(bytes) {
  const { doc, text } = await dump(bytes);
  const catalogKeys = doc.catalog.keys().map((k) => k.asString()).sort();
  assert.deepEqual(catalogKeys, ['/Pages', '/Type'], 'catalog must only hold /Type and /Pages');
  assert.equal(doc.context.trailerInfo.Info, undefined, 'no Info dict');
  assert.ok(!latin1(bytes).includes('/Info'), 'no /Info in trailer or xref stream');
  assert.equal(doc.context.trailerInfo.Encrypt, undefined);
  for (const word of ['EVIL', '/JavaScript', '/JS', '/Launch', '/SubmitForm', '/ImportData', '/GoToR', '/GoToE',
    '/EmbeddedFile', '/AcroForm', '/Widget', '/OpenAction', '/Metadata', '/AA', 'pdf-lib', '/Producer', '/Author', 'xmpmeta']) {
    assert.ok(!text.includes(word), `output must not contain ${word}`);
  }
  for (const page of doc.getPages()) {
    assert.equal(page.node.get(PDFName.of('AA')), undefined, 'no page /AA');
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (annots) {
      for (const a of annots.asArray()) {
        const d = doc.context.lookup(a);
        assert.equal(d.get(PDFName.of('Subtype')), PDFName.of('Link'));
        const act = doc.context.lookup(d.get(PDFName.of('A')));
        assert.equal(act.get(PDFName.of('S')), PDFName.of('URI'));
        assert.deepEqual(d.keys().map((k) => k.asString()).sort(), ['/A', '/Border', '/Rect', '/Subtype', '/Type']);
      }
    }
  }
  return { doc, text };
}

/**
 * Zlib data that inflates to about `n` spaces, built from ONE byte-aligned fixed-Huffman block repeated as bytes, so
 * multi-GB bombs (QA MCP case: ObjStm inflating to 6.2 GB) are built in ~100 ms. Block = 1 literal (first block only)
 * or none, then M copies (length 258, distance 1), EOB; M = 1022 keeps every block a whole number of bytes.
 */
export function deflateBombRepeated(n) {
  const M = 1022;
  const block = (lit) => {
    const out = [];
    let acc = 0, bits = 0;
    const put = (v, len) => { acc |= v << bits; bits += len; while (bits >= 8) { out.push(acc & 0xff); acc >>>= 8; bits -= 8; } };
    const putRev = (code, len) => { let r = 0; for (let k = 0; k < len; k++) r |= ((code >> k) & 1) << (len - 1 - k); put(r, len); };
    put(0, 1); put(1, 2); // not final, fixed Huffman
    if (lit) putRev(0x30 + 0x20, 8);
    for (let k = 0; k < M; k++) { putRev(0xc5, 8); putRev(0, 5); }
    putRev(0, 7);
    assert.equal(bits, 0); // 3 + (8) + 13 * 1022 + 7 bits: whole bytes with and without the literal
    return Buffer.from(out);
  };
  // first block: 3 + 8 + 13 * 1022 + 7 bits = 13304 bits = 1663 bytes, aligned as well
  const first = block(true);
  const rep = block(false);
  const count = Math.ceil(n / (M * 258));
  const fin = Buffer.from([0x03, 0x00]); // final fixed block with only EOB, then 0-padding
  return Buffer.concat([Buffer.from([0x78, 0x01]), first, Buffer.concat(Array(count).fill(rep)), fin, Buffer.alloc(4)]);
}

/** Valid 1-page PDF plus an /ObjStm whose Flate data is `z`. */
export function objStmBombPdf(z) {
  const hdr = '9 0 ';
  const parts = [Buffer.from('%PDF-1.5\n')];
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\n',
  ];
  for (const o of objs) parts.push(Buffer.from(o));
  parts.push(Buffer.from(`4 0 obj\n<< /Type /ObjStm /N 1 /First ${hdr.length} /Length ${z.length} /Filter /FlateDecode >>\nstream\n`), z, Buffer.from('\nendstream\nendobj\n'));
  parts.push(Buffer.from('trailer\n<< /Root 1 0 R /Size 5 >>\n%%EOF\n'));
  return new Uint8Array(Buffer.concat(parts));
}

