// flateSize (src/decode.js) boundary and malformed-stream behaviour, exercised through
// boundedDecode. The 500 MiB budget (LIMITS.MAX_DECOMPRESSED_BYTES) is tested at its exact
// edge cheaply: the budget is pre-charged so that only ~1 MiB is left, and a 1 MiB stream of
// one repeated byte (~1 KiB compressed) is decoded against it.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { boundedDecode, newBudget } from '../src/decode.js';
import { LIMITS, PdfToolError } from '../src/index.js';
import * as core from '../src/index.js';
import { objStmBombPdf } from './helpers.mjs';

const LIMIT = LIMITS.MAX_DECOMPRESSED_BYTES;
const SIZE = 1024 * 1024;
const RAW = Buffer.alloc(SIZE, 0x41);
const Z = new Uint8Array(zlib.deflateSync(RAW));
const doc = await PDFDocument.create();
const flateDict = doc.context.obj({ Filter: 'FlateDecode' });

// Budget with exactly `left` bytes remaining of the real 500 MiB limit.
const budgetLeft = (left) => { const b = newBudget(); b.used = LIMIT - left; return b; };
const corruptMid = () => { const c = Buffer.from(Z); const m = c.length >> 1; for (let i = m; i < m + 8; i++) c[i] ^= 0xff; return new Uint8Array(c); };

test('flateSize: 500 MiB limit is the real cap', () => {
  assert.equal(LIMIT, 500 * 1024 * 1024);
  assert.ok(Z.length < 4096, 'stream stays cheap');
});

test('flateSize boundary: total = limit - 1 passes', () => {
  const b = budgetLeft(SIZE + 1);
  const out = boundedDecode(flateDict, Z, b);
  assert.equal(out.length, SIZE);
  assert.equal(b.used, LIMIT - 1);
  assert.equal(b.exceeded, false);
});

test('flateSize boundary: total = limit exactly passes (check is n > left)', () => {
  const b = budgetLeft(SIZE);
  const out = boundedDecode(flateDict, Z, b);
  assert.equal(out.length, SIZE);
  assert.equal(b.used, LIMIT);
  assert.equal(b.exceeded, false);
});

test('flateSize boundary: total = limit + 1 gives TOO_LARGE', () => {
  const b = budgetLeft(SIZE - 1);
  assert.throws(() => boundedDecode(flateDict, Z, b), (e) =>
    e instanceof PdfToolError && e.code === 'TOO_LARGE' && e.details?.reason === 'decompressed' && e.details?.limit === LIMIT);
  assert.equal(b.exceeded, true);
  // an exceeded budget stays exceeded for the rest of the call
  assert.throws(() => boundedDecode(flateDict, Z, b), (e) => e.code === 'TOO_LARGE');
});

test('flateSize: corrupted mid-stream decodes the recoverable prefix, budget not exceeded', () => {
  const b = newBudget();
  const out = boundedDecode(flateDict, corruptMid(), b);
  assert.ok(out.length > 0 && out.length <= SIZE);
  assert.equal(b.used, out.length);
  assert.equal(b.exceeded, false);
});

test('flateSize: corrupted mid-stream still hits TOO_LARGE when it would pass the budget', () => {
  const b = budgetLeft(1024);
  assert.throws(() => boundedDecode(flateDict, corruptMid(), b), (e) => e.code === 'TOO_LARGE');
});

test('flateSize: truncated stream -> pdf-lib decode error (not TOO_LARGE), budget untouched', () => {
  const b = newBudget();
  assert.throws(() => boundedDecode(flateDict, Z.subarray(0, Z.length >> 1), b), /Bad encoding in flate stream/);
  assert.equal(b.used, 0);
  assert.equal(b.exceeded, false);
});

test('flateSize: gzip-wrapped stream counts 0, pdf-lib rejects it', () => {
  const b = newBudget();
  assert.throws(() => boundedDecode(flateDict, new Uint8Array(zlib.gzipSync(RAW)), b), /Unknown compression method/);
  assert.equal(b.exceeded, false);
});

// Through the public API pdf-lib swallows the per-object decode error (the ObjStm is
// dropped) and the call resolves; nothing raw leaks out.
for (const [name, z] of [['truncated', Z.subarray(0, Z.length >> 1)], ['corrupted', corruptMid()], ['gzip', new Uint8Array(zlib.gzipSync(RAW))]]) {
  test(`flateSize: ${name} ObjStm through pdfInfo resolves, no throw leaks`, async () => {
    assert.deepEqual(await core.pdfInfo(objStmBombPdf(z)), { pages: 1 });
  });
}
