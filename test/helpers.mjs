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
