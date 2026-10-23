// 50 MP limit read from image headers (spec: design/pdf-tool/spec.md, IMAGE_TOO_LARGE).
// Fixtures here are header-only (no real pixel data), so a pass means nothing was decoded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { imagesToPdf, jpegFrames, jpegSize, imagePixels, pngSize, stripPng, LIMITS } from '../src/index.js';
import * as fx from './fixtures/gen.mjs';
import { expectCode } from './helpers.mjs';

const seg = (m, payload) => [0xff, m, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const sof = (m, w, h) => seg(m, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0]);
const sos = () => [...seg(0xda, [1, 1, 0, 0, 63, 0]), 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56];
/** SOI + segments + EOI; frames = [[marker, w, h], ...] each followed by a scan. */
function jpeg(frames, { eoi = true, scans = true } = {}) {
  const out = [0xff, 0xd8, ...seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0])];
  for (const [m, w, h] of frames) { out.push(...sof(m, w, h)); if (scans && m !== 0xde) out.push(...sos()); }
  if (eoi) out.push(0xff, 0xd9);
  return Uint8Array.from(out);
}
const be32 = (v) => [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255];
function chunk(type, data) {
  return [...be32(data.length), ...Buffer.from(type, 'latin1'), ...data, 0, 0, 0, 0];
}
const ihdr = (w, h) => chunk('IHDR', [...be32(w), ...be32(h), 8, 2, 0, 0, 0]);
function png(...chunks) {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunks.flat(), ...chunk('IEND', [])]);
}
const idat = () => chunk('IDAT', [...deflateSync(new Uint8Array(16))]);

test('limit constant is 50,000,000 pixels', () => {
  assert.equal(LIMITS.MAX_IMAGE_PIXELS, 50_000_000);
});

test('JPEG frame headers: baseline, extended, progressive, lossless, arithmetic, hierarchical', () => {
  for (const m of [0xc0, 0xc1, 0xc2, 0xc3, 0xc9, 0xca, 0xcb]) {
    const b = jpeg([[m, 640, 480]]);
    assert.deepEqual(jpegFrames(b), [{ marker: m, width: 640, height: 480 }], m.toString(16));
    assert.deepEqual(jpegSize(b), { width: 640, height: 480 });
  }
  // DHT/JPG/DAC (0xC4/0xC8/0xCC) are not frame headers.
  assert.deepEqual(jpegFrames(jpeg([[0xc4, 9999, 9999], [0xc0, 10, 10]], { scans: false })).map((f) => f.marker), [0xc0]);
  assert.deepEqual(jpegFrames(jpeg([[0xde, 20000, 20000], [0xc5, 100, 100]])).map((f) => f.marker), [0xde, 0xc5]);
});

test('JPEG: every SOF counts, including frames after the first scan', () => {
  const sneaky = jpeg([[0xc0, 16, 16], [0xc2, 20000, 20000]]);
  assert.deepEqual(jpegSize(sneaky), { width: 16, height: 16 }, 'layout keeps first frame');
  assert.deepEqual(imagePixels(sneaky, 'jpeg'), { width: 20000, height: 20000, pixels: 4e8 });
  assert.deepEqual(jpegFrames(sneaky).length, 2);
});

test('JPEG with a huge second SOF / progressive / DHP is rejected before decoding', async () => {
  for (const frames of [
    [[0xc0, 16, 16], [0xc0, 20000, 20000]],
    [[0xc2, 16, 16], [0xc2, 3561, 14041]], // progressive, 50,000,001 px
    [[0xde, 65535, 65535], [0xc1, 16, 16]], // hierarchical DHP declares the full size
    [[0xc2, 65535, 65535]],
  ]) {
    const e = await expectCode(imagesToPdf([{ bytes: fx.plainJpeg() }, { bytes: jpeg(frames) }]), 'IMAGE_TOO_LARGE');
    assert.equal(e.details.index, 1);
    assert.equal(e.details.max, 50_000_000);
    const big = frames.reduce((a, f) => (f[1] * f[2] > a[1] * a[2] ? f : a));
    assert.deepEqual([e.details.width, e.details.height], [big[1], big[2]]);
  }
});

test('JPEG truncated after the first frame, or without EOI, still reads the header', async () => {
  const b = jpeg([[0xc2, 20000, 20000]], { eoi: false });
  assert.equal(imagePixels(b, 'jpeg').pixels, 4e8);
  await expectCode(imagesToPdf([{ bytes: b }]), 'IMAGE_TOO_LARGE');
  const cut = jpeg([[0xc0, 10, 10], [0xc0, 20000, 20000]]).subarray(0, 40);
  assert.deepEqual(jpegSize(cut), { width: 10, height: 10 });
});

test('JPEG without a frame header / with zero size stays IMAGE_INVALID', async () => {
  await expectCode(imagesToPdf([{ bytes: Uint8Array.of(0xff, 0xd8, ...sos(), 0xff, 0xd9) }]), 'IMAGE_INVALID');
  await expectCode(imagesToPdf([{ bytes: jpeg([[0xc0, 0, 100]]) }]), 'IMAGE_INVALID');
});

test('boundary JPEG: exactly 50,000,000 px passes, 50,000,001 px fails', async () => {
  // jpegWithSize = real 24x16 JPEG with a patched SOF; pdf-lib embeds JPEG without decoding.
  for (const [w, h] of [[10000, 5000], [5000, 10000]]) {
    const pdf = await imagesToPdf([{ bytes: fx.jpegWithSize(w, h) }]);
    assert.ok(pdf.length > 0, `${w}x${h}`);
  }
  for (const [w, h] of [[3561, 14041], [14041, 3561], [10000, 5001]]) {
    const e = await expectCode(imagesToPdf([{ bytes: fx.jpegWithSize(w, h) }]), 'IMAGE_TOO_LARGE');
    assert.deepEqual([e.details.width, e.details.height], [w, h]);
  }
  await expectCode(imagesToPdf([{ bytes: jpeg([[0xc2, 3561, 14041]]) }]), 'IMAGE_TOO_LARGE');
});

test('boundary PNG: exactly 50,000,000 px is within the limit, 50,000,001 px fails', async () => {
  assert.equal(imagePixels(png(ihdr(10000, 5000), idat()), 'png').pixels, 50_000_000);
  assert.ok(imagePixels(png(ihdr(10000, 5000), idat()), 'png').pixels <= LIMITS.MAX_IMAGE_PIXELS);
  for (const [w, h] of [[3561, 14041], [42123, 1187], [1, 50_000_001], [0x7fffffff, 0x7fffffff]]) {
    const e = await expectCode(imagesToPdf([{ bytes: png(ihdr(w, h), idat()) }]), 'IMAGE_TOO_LARGE');
    assert.deepEqual([e.details.width, e.details.height], [w, h]);
  }
});

test('PNG with a second IHDR (small then huge) is IMAGE_INVALID, never decoded', async () => {
  const b = png(ihdr(8, 8), ihdr(20000, 20000), idat());
  assert.throws(() => pngSize(b), (e) => e.code === 'IMAGE_INVALID');
  assert.throws(() => stripPng(b), (e) => e.code === 'IMAGE_INVALID');
  const e = await expectCode(imagesToPdf([{ bytes: fx.plainPng() }, { bytes: b }]), 'IMAGE_INVALID');
  assert.equal(e.details.index, 1);
  // IHDR not first: still rejected as before.
  await expectCode(imagesToPdf([{ bytes: png(chunk('tEXt', [0x61, 0]), ihdr(8, 8), idat()) }]), 'IMAGE_INVALID');
});

test('header-only check is fast on many oversized images (no decode)', async () => {
  const t0 = Date.now();
  for (let k = 0; k < 50; k++) await expectCode(imagesToPdf([{ bytes: jpeg([[0xc0, 16, 16], [0xc2, 65535, 65535]]) }]), 'IMAGE_TOO_LARGE');
  for (let k = 0; k < 50; k++) await expectCode(imagesToPdf([{ bytes: png(ihdr(65535, 65535), idat()) }]), 'IMAGE_TOO_LARGE');
  assert.ok(Date.now() - t0 < 2000);
});
