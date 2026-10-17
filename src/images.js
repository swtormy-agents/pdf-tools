import { fail } from './errors.js';

/** Read width/height from a JPEG SOFn segment without decoding. */
export function jpegSize(b) {
  const n = b.length;
  if (n < 4 || b[0] !== 0xff || b[1] !== 0xd8) fail('IMAGE_INVALID', 'Not a JPEG file');
  let i = 2;
  while (i < n) {
    if (b[i] !== 0xff) fail('IMAGE_INVALID', 'Corrupt JPEG marker');
    while (i < n && b[i] === 0xff) i++;
    if (i >= n) break;
    const m = b[i++];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
    if (m === 0xd9 || m === 0xda) break; // EOI / SOS before any SOF
    if (i + 2 > n) break;
    const len = (b[i] << 8) | b[i + 1];
    if (len < 2 || i + len > n) fail('IMAGE_INVALID', 'Corrupt JPEG segment');
    const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (isSof) {
      if (len < 8) fail('IMAGE_INVALID', 'Corrupt JPEG SOF');
      const height = (b[i + 3] << 8) | b[i + 4];
      const width = (b[i + 5] << 8) | b[i + 6];
      if (width === 0 || height === 0) fail('IMAGE_INVALID', 'JPEG without dimensions');
      return { width, height };
    }
    i += len;
  }
  fail('IMAGE_INVALID', 'JPEG has no frame header');
}

// Segments kept: APP0 (JFIF), APP2 only when it is an ICC_PROFILE (colour profile), APP14
// (Adobe: colour transform, required or CMYK/YCCK colours invert), plus all non-APP
// segments (tables, frame, scan). Dropped: APP1 (EXIF incl. GPS, XMP), APP13 (IPTC /
// Photoshop), COM, non-ICC APP2 (MPF, FlashPix), APP3..APP12 and APP15 (vendor data).
// Data after EOI (MPF secondary images, trailers) is dropped too.
const ICC_ID = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00]; // "ICC_PROFILE\0"

function startsWith(b, i, sig) {
  if (i + sig.length > b.length) return false;
  for (let k = 0; k < sig.length; k++) if (b[i + k] !== sig[k]) return false;
  return true;
}

function keepJpegSegment(m, b, payloadStart) {
  if (m === 0xe0 || m === 0xee) return true;
  if (m === 0xe2) return startsWith(b, payloadStart, ICC_ID);
  if (m >= 0xe1 && m <= 0xef) return false;
  if (m === 0xfe) return false;
  return true;
}

const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

/**
 * EXIF Orientation (1..8) from the first APP1 Exif segment, read before stripping.
 * Returns 1 when absent or invalid.
 */
export function jpegOrientation(b) {
  const n = b.length;
  if (n < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 <= n && b[i] === 0xff) {
    while (i < n && b[i] === 0xff) i++;
    const m = b[i++];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
    if (m === 0xda || m === 0xd9 || i + 2 > n) return 1;
    const len = (b[i] << 8) | b[i + 1];
    if (len < 2 || i + len > n) return 1;
    if (m === 0xe1 && startsWith(b, i + 2, EXIF_ID)) return tiffOrientation(b, i + 8, i + len);
    i += len;
  }
  return 1;
}

function tiffOrientation(b, t, end) {
  if (t + 8 > end) return 1;
  let le;
  if (b[t] === 0x49 && b[t + 1] === 0x49) le = true;
  else if (b[t] === 0x4d && b[t + 1] === 0x4d) le = false;
  else return 1;
  const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32le = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000 : b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]));
  if (u16(t + 2) !== 42) return 1;
  const ifd = t + u32le(t + 4);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) return 1;
    if (u16(e) === 0x0112) {
      const type = u16(e + 2);
      const v = type === 3 ? u16(e + 8) : type === 4 ? u32le(e + 8) : 0;
      return Number.isInteger(v) && v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

/**
 * Return a copy of a JPEG without metadata segments, without re-encoding (entropy-coded
 * data is copied byte for byte). pdf-lib embeds JPEG bytes as-is (DCTDecode), so anything
 * left here would end up in the PDF.
 */
export function stripJpeg(b) {
  const n = b.length;
  if (n < 4 || b[0] !== 0xff || b[1] !== 0xd8) fail('IMAGE_INVALID', 'Not a JPEG file');
  const parts = [Uint8Array.of(0xff, 0xd8)];
  let i = 2;
  for (;;) {
    if (i >= n) { parts.push(Uint8Array.of(0xff, 0xd9)); break; }
    if (b[i] !== 0xff) fail('IMAGE_INVALID', 'Corrupt JPEG marker');
    while (i < n && b[i] === 0xff) i++;
    if (i >= n) { parts.push(Uint8Array.of(0xff, 0xd9)); break; }
    const m = b[i++];
    if (m === 0xd9) { parts.push(Uint8Array.of(0xff, 0xd9)); break; }
    if (m === 0xd8) fail('IMAGE_INVALID', 'Nested JPEG SOI');
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { parts.push(Uint8Array.of(0xff, m)); continue; }
    if (i + 2 > n) fail('IMAGE_INVALID', 'Truncated JPEG segment');
    const len = (b[i] << 8) | b[i + 1];
    if (len < 2 || i + len > n) fail('IMAGE_INVALID', 'Corrupt JPEG segment');
    if (keepJpegSegment(m, b, i + 2)) {
      parts.push(Uint8Array.of(0xff, m));
      parts.push(b.subarray(i, i + len));
    }
    i += len;
    if (m === 0xda) {
      // Entropy-coded data runs until a marker that is not a stuffed byte or RSTn.
      let j = i;
      while (j < n) {
        if (b[j] === 0xff && j + 1 < n) {
          const nx = b[j + 1];
          if (nx === 0x00 || (nx >= 0xd0 && nx <= 0xd7)) { j += 2; continue; }
          break;
        }
        j++;
      }
      parts.push(b.subarray(i, j));
      i = j;
    }
  }
  return concat(parts);
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(b) {
  if (b.length < 8) return false;
  for (let k = 0; k < 8; k++) if (b[k] !== PNG_SIG[k]) return false;
  return true;
}

function u32(b, i) {
  return ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
}

/** Read width/height from the PNG IHDR chunk without decoding. */
export function pngSize(b) {
  if (!isPng(b) || b.length < 33) fail('IMAGE_INVALID', 'Not a PNG file');
  const type = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (u32(b, 8) !== 13 || type !== 'IHDR') fail('IMAGE_INVALID', 'PNG without IHDR');
  const width = u32(b, 16);
  const height = u32(b, 20);
  if (width === 0 || height === 0) fail('IMAGE_INVALID', 'PNG without dimensions');
  return { width, height };
}

// Chunks pdf-lib (UPNG) needs to decode the first frame. Everything else (tEXt, iTXt, zTXt,
// eXIf, tIME, iCCP, vendor chunks, APNG frames) is dropped.
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

/**
 * Return a copy of a PNG with only the chunks needed to decode it. pdf-lib decodes PNG to
 * pixels and re-encodes them, so text/EXIF chunks would not reach the PDF anyway; this is
 * defence in depth.
 */
export function stripPng(b) {
  if (!isPng(b)) fail('IMAGE_INVALID', 'Not a PNG file');
  const parts = [b.subarray(0, 8)];
  let i = 8;
  let sawEnd = false;
  while (i + 12 <= b.length) {
    const len = u32(b, i);
    const end = i + 12 + len;
    if (end > b.length) fail('IMAGE_INVALID', 'Corrupt PNG chunk');
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    if (PNG_KEEP.has(type)) parts.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') { sawEnd = true; break; }
  }
  if (!sawEnd) fail('IMAGE_INVALID', 'PNG without IEND');
  return concat(parts);
}

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
