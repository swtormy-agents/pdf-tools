// Generator for the v3 fixtures (QA follow-up on 006ee6a): `node test/qa/fixtures/v3/gen.mjs`.
// Synthetic only; LEAK-* strings are canaries that must not appear in any output.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const dir = new URL('./', import.meta.url);

/** Build a classic-xref PDF from [num, body] pairs; body is a string or [dictString, streamBytes]. */
function build(objs, root = 1) {
  const parts = [Buffer.from('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let off = parts[0].length;
  const xref = [];
  for (const [n, body] of objs) {
    let b;
    if (Array.isArray(body)) {
      const [dict, data] = body;
      b = Buffer.concat([Buffer.from(`${n} 0 obj\n${dict.replace('>>$', ` /Length ${data.length} >>`)}\nstream\n`, 'latin1'), data, Buffer.from('\nendstream\nendobj\n')]);
    } else b = Buffer.from(`${n} 0 obj\n${body}\nendobj\n`, 'latin1');
    xref[n] = off; off += b.length; parts.push(b);
  }
  const size = xref.length;
  let x = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let k = 1; k < size; k++) x += xref[k] === undefined ? '0000000000 65535 f \n' : `${String(xref[k]).padStart(10, '0')} 00000 n \n`;
  parts.push(Buffer.from(`${x}trailer\n<< /Root ${root} 0 R /Size ${size} >>\nstartxref\n${off}\n%%EOF\n`));
  return Buffer.concat(parts);
}
const priv = (n) => `/PrivData ${n} 0 R /XLeak (LEAK-KEY)`;

// Image, ICCBased, Separation + tint Function, DeviceN attrs, Lab, axial Shading, shading Pattern and
// tiling Pattern, each with private keys pointing to a LEAK stream (obj 99).
const img = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
const tile = Buffer.from('0 0 1 rg 0 0 5 5 re f');
const content = Buffer.from([
  'q 80 0 0 80 10 10 cm /Im1 Do Q',
  '/CS1 cs 1 scn 100 10 40 40 re f',
  '/CS2 cs 0.5 scn 150 10 40 40 re f',
  '/CS3 cs 0.7 0.3 scn 10 100 40 40 re f',
  '/CS4 cs 50 20 -30 scn 60 100 40 40 re f',
  '/Pattern cs /P1 scn 110 100 80 40 re f',
  '/Pattern cs /P2 scn 10 150 80 40 re f',
  'q 100 150 90 40 re W n /Sh1 sh Q',
].join('\n'));
const objs = [
  [1, '<< /Type /Catalog /Pages 2 0 R >>'],
  [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
  [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> '
    + '/ColorSpace << /CS1 [/ICCBased 6 0 R] /CS2 [/Separation /Spot /DeviceRGB 7 0 R] /CS3 [/DeviceN [/A /B] /DeviceRGB 8 0 R 9 0 R] '
    + '/CS4 [/Lab 10 0 R] >> /Pattern << /P1 11 0 R /P2 12 0 R >> /Shading << /Sh1 13 0 R >> >> >>'],
  [4, ['<< >>$', content]],
  [5, [`<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Name /Im1 /ID (LEAK-ID) /StructParent 3 /OC 98 0 R /Alternates [] ${priv(99)} >>$`, img]],
  [6, [`<< /N 3 /Alternate /DeviceRGB ${priv(99)} >>$`, Buffer.from('not-a-profile')]],
  [7, `<< /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [1 0.5 0] /N 1 ${priv(99)} >>`],
  [8, [`<< /FunctionType 4 /Domain [0 1 0 1] /Range [0 1 0 1 0 1] ${priv(99)} >>$`, Buffer.from('{ 0 }')]],
  [9, `<< /Subtype /DeviceN /Colorants << >> ${priv(99)} >>`],
  [10, `<< /WhitePoint [0.9505 1 1.089] /Range [-100 100 -100 100] ${priv(99)} >>`],
  [11, `<< /Type /Pattern /PatternType 2 /Shading 13 0 R ${priv(99)} >>`],
  [12, [`<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >> ${priv(99)} >>$`, tile]],
  [13, `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 200 0] /Function 14 0 R /Extend [true true] ${priv(99)} >>`],
  [14, `<< /FunctionType 2 /Domain [0 1] /C0 [0 1 0] /C1 [0 0 1] /N 1 ${priv(99)} >>`],
  [98, '<< /Type /OCG /Name (LEAK-OCG) >>'],
  [99, ['<< >>$', Buffer.from('LEAK-PRIVATE-STREAM-PAYLOAD')]],
];
writeFileSync(new URL('privkeys-image-cs-pattern-shading.pdf', dir), build(objs));

// ObjStm Flate bomb (1 GiB of spaces) whose /Type is an indirect reference, resolved backwards (obj 5
// before the stream) or forwards (obj 6 after it).
for (const [name, typeObjFirst] of [['objstm-bomb-indirect-type-back', true], ['objstm-bomb-indirect-type-fwd', false]]) {
  const z = deflateSync(Buffer.alloc(600 * 1024 * 1024, 0x20), { level: 9 });
  const typeObj = [5, '/ObjStm'];
  const list = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>'],
  ];
  if (typeObjFirst) list.push(typeObj);
  list.push([4, ['<< /Type 5 0 R /N 1 /First 4 /Filter /FlateDecode >>$', z]]);
  if (!typeObjFirst) list.push(typeObj);
  writeFileSync(new URL(`${name}.pdf`, dir), build(list));
}
