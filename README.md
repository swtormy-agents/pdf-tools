# @local-pdf-tools/core

Pure JavaScript PDF functions for local, private PDF tools: **merge, split, organize
(reorder / rotate / delete) and images to PDF**. Every function takes `Uint8Array` input
plus plain parameters and returns `Uint8Array` output.

- No filesystem, no DOM, no network, no global state. Runs in browsers, Node >= 18 and workers.
- ESM only, named exports only (no default export). TypeScript declarations included.
- Runtime dependencies: [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1 (MIT) and
  [pako](https://github.com/nodeca/pako) 1.0.11 (MIT AND Zlib, already a pdf-lib
  dependency; used directly for the decompression cap), both pinned exactly. See
  [THIRD-PARTY.md](THIRD-PARTY.md).
- Outputs are always new documents, cleaned of metadata, scripts, forms and attachments
  (see [Security](#security)).

Status: `0.1.0`, `private: true` (not published to npm). Consume it as a git dependency:

```json
"dependencies": { "@local-pdf-tools/core": "github:swtormy-agents/pdf-tools#<commit-sha>" }
```

```js
import { merge, split, organize, imagesToPdf, pdfInfo, PdfToolError } from '@local-pdf-tools/core';
```

## API

All functions are `async` (return a `Promise`) except `parsePageRanges` and the helpers.
Page **numbers** are 1-based (human); page **indexes** are 0-based (as in `organize`).

### `pdfInfo(bytes: Uint8Array): Promise<{ pages: number }>`

Page count of a PDF. Encrypted or password-protected files throw `PDF_ENCRYPTED`
(they are never opened with `ignoreEncryption`), so there is no `encrypted` field.
(`0.1.0` before this change returned an always-`false` `encrypted` field; it was removed.)

### `merge(list: Array<{ bytes: Uint8Array, pages?: string | number[] }>): Promise<Uint8Array>`

Concatenates documents in list order. `pages` selects pages of that item: a 1-based range
string (`'1-3,5'`, same syntax as `parsePageRanges`, groups flattened in order) or an array
of 0-based indexes (repeats allowed). Omitted = all pages.
`PAGE_RANGE` details: `{ index, position, page, pageCount }` for a bad array entry
(`index` = input item, `position` = 0-based position in its `pages` array, `page` = the
bad value or `null` if not a number), `{ index, from, to, pageCount }` for a bad range
string, `{ index, pageCount }` for an empty or wrongly typed selection.

### `split(bytes: Uint8Array, ranges: string | Array<[from: number, to: number]>): Promise<Array<{ pages: number[], bytes: Uint8Array }>>`

One output document per range group. `ranges` is a 1-based range string (`'1-3,5'` gives two
documents: pages 1-3 and page 5) or an array of inclusive 1-based `[from, to]` pairs.
`pages` in each result lists the 1-based source pages it contains. There is no "every N
pages" mode; build the ranges on the caller side.

- Limits, all checked before any page is copied; `details.limit` names the limit hit:
  - each part: at most `MAX_PAGES` (1000) pages, else `TOO_MANY_PAGES`
    `{ limit: 'part', max: 1000, part, pages }` (0-based part index). A 2000-page input
    split into `'1-1000,1001-2000'` works;
  - all parts together (repeats counted): at most `MAX_SPLIT_TOTAL_PAGES` (5000), else
    `TOO_MANY_PAGES` `{ limit: 'total', max: 5000, total }`; a long repeated spec such as
    `'1-1000,1-1000,...'` stops as soon as the total passes the limit. A range string longer
    than 1 000 000 characters is rejected up front with `PAGE_RANGE`
    `{ maxLength: 1000000 }`; anything shorter is parsed and limited by its page total;
  - at most `MAX_SPLIT_PARTS` (50) parts, else `TOO_MANY_FILES`
    `{ limit: 'parts', max: 50, parts }`;
  - reversed ranges (`'5-3'`, `[5, 3]`) -> `PAGE_RANGE` `{ from, to }`.
- Open ranges work as in `parsePageRanges`: `'-3'` = pages 1-3, `'5-'` = page 5 to the
  last page, `'-1'` = page 1.

### `organize(bytes: Uint8Array, ops: { order: number[], rotate?: { [index: number]: number } }): Promise<Uint8Array>`

- `order`: the final page sequence as 0-based ORIGINAL indexes. Pages absent from `order`
  are deleted. Repeats are allowed (each copy counts against `MAX_PAGES`). Empty or missing
  `order` -> `PAGE_RANGE`.
- `rotate`: original index -> degrees. Must be a multiple of 90 (negative allowed); it is
  added to the page's existing rotation and normalized mod 360. Applies to every copy of
  that page. Non-multiples of 90 -> `PAGE_RANGE`.
- `PAGE_RANGE` details (message unchanged):
  - bad `order` entry: `{ index, page, pageCount }` — `index` = 0-based position in `order`,
    `page` = the original page index given there (`null` if not a number);
  - bad `rotate` key: `{ page, pageCount }`; bad angle: `{ page, degrees, pageCount }`;
  - empty/missing `order` or non-object `rotate`: `{ pageCount }`.

  ```js
  // 3-page document
  await organize(bytes, { order: [2, 0, 5] });
  // PdfToolError PAGE_RANGE 'order index out of range 0-2', details { index: 2, page: 5, pageCount: 3 }
  ```

### `imagesToPdf(list: Array<{ bytes: Uint8Array, type?: string }>, options?: { pageSize?: 'fit' | 'A4' | 'Letter', margin?: number }): Promise<Uint8Array>`

One page per image, in list order. The format is detected from magic bytes (JPEG
`FF D8 FF`, PNG signature); `type` is optional and ignored. EXIF orientation (1..8) is
applied (orientations 5-8 swap width and height).

- `pageSize: 'fit'` (default): each page has the size of the image, 1 px = 1 pt. A page is
  scaled down only if a side would exceed 14 400 pt, the PDF implementation limit.
- `pageSize: 'A4'` (595.28 x 841.89 pt) or `'Letter'` (612 x 792 pt): portrait page; the
  image is scaled (up or down) to fit inside the margins, aspect ratio preserved, centered.
  Exported as `PAGE_SIZES`.
- `margin`: points on every side, default `0`. With `'fit'` the page grows by `2 * margin`.
  Must be `>= 0` and less than half the shorter page side (`'fit'`: `< 3600`).
- Invalid options -> `PDF_INVALID` with `details.option` (`'pageSize'` / `'margin'`).
- Without options (or `{}`) the output is byte-for-byte the same as before the options existed.

- Pixel dimensions are read from the JPEG SOF / PNG IHDR header and checked against
  `MAX_IMAGE_PIXELS` **before** any decoding or embedding (`IMAGE_TOO_LARGE`).
- JPEG is embedded without re-encoding. Removed first: APP1 (EXIF incl. GPS, XMP), APP13
  (IPTC/Photoshop), COM, APP2 segments that are not `ICC_PROFILE` (MPF, FlashPix),
  APP3-APP12, APP15, and any data after EOI. Kept: APP0 (JFIF), APP2 `ICC_PROFILE`, APP14
  (Adobe, needed for correct CMYK/YCCK colours), and all tables/frame/scan data.
- PNG: only `IHDR`, `PLTE`, `tRNS`, `IDAT`, `IEND` are passed to pdf-lib, which decodes
  and re-encodes the pixels; `tEXt`, `iTXt`, `zTXt`, `eXIf`, `tIME` etc. never reach the PDF.

### `parsePageRanges(spec: string, pageCount: number, maxTotal = LIMITS.MAX_PAGES): number[][]`

`'1-3,5'` with 10 pages -> `[[0, 1, 2], [4]]` (0-based groups).

- Group separators: `,` and fullwidth `，` (U+FF0C).
- Range dashes: `-`, en dash `–` (U+2013), `~`, fullwidth `～` (U+FF5E).
- Whitespace (incl. U+3000) is ignored anywhere; empty groups (`1,,2`, trailing `,`) are skipped.
- Open ranges are valid: `'-3'` = pages 1 to 3, `'5-'` = page 5 to the last page, `'-1'` = page 1. They are
  still checked against `pageCount` (`'-11'` or `'11-'` with 10 pages -> `PAGE_RANGE`).
- `PAGE_RANGE` only for: numbers outside `1..pageCount` (incl. `0`), reversed ranges
  (`'5-3'`), or input that cannot be parsed (`'a'`, `'1-2-3'`, `'-'`, `'1.5'`, no group). More than `maxTotal` pages over all groups -> `TOO_MANY_PAGES`.
  Out-of-range and reversed errors carry `details` `{ from, to, pageCount }` / `{ from, to }`.

### Helpers

`jpegSize(bytes)`, `pngSize(bytes)` -> `{ width, height }` from the header;
`jpegOrientation(bytes)` -> `1..8`; `stripJpeg(bytes)`, `stripPng(bytes)` -> cleaned copy;
`orientationMatrix(orientation, width, height)` -> PDF `cm` matrix `[a, b, c, d, e, f]`;
`PAGE_SIZES` -> `{ A4: [595.28, 841.89], Letter: [612, 792] }` (points, portrait).

### `LIMITS`

Frozen object, used by the core itself; there is no per-call override.

| Field | Value | Applies to |
|---|---|---|
| `MAX_FILE_BYTES` | `100 * 1024 * 1024` | each input file (PDF or image) |
| `MAX_TOTAL_BYTES` | `300 * 1024 * 1024` | all inputs of one call together |
| `MAX_PAGES` | `1000` | pages of the RESULT: `merge` / `organize` output, each `split` part. Inputs may be longer (bounded by `MAX_FILE_BYTES`) |
| `MAX_SPLIT_TOTAL_PAGES` | `5000` | `split`: pages of all parts together (repeats counted) |
| `MAX_SPLIT_PARTS` | `50` | `split`: number of output parts |
| `MAX_FILES` | `50` | items in `merge` / `imagesToPdf` |
| `MAX_IMAGE_PIXELS` | `50_000_000` | width x height of each image, from the header (JPEG: the largest of all SOFn/DHP frame headers up to EOI; PNG: the single IHDR, a second IHDR is `IMAGE_INVALID`); exactly 50,000,000 passes |
| `MAX_DECOMPRESSED_BYTES` | `500 * 1024 * 1024` | bytes decompressed from PDF streams during one call, all inputs together (object streams, xref streams, filters in front of DCTDecode images) |

Byte and file-count limits are checked before anything is parsed.

### Errors

Every failure is thrown as `class PdfToolError extends Error` with:

- `.name === 'PdfToolError'`
- `.code`: string, one of `ERROR_CODES`
- `.message`: English, never contains document content
- `.details` (optional): small object, e.g. `{ index }` (which input item) or `{ max }`;
  `PAGE_RANGE` details are described under `merge`, `split` (`{ from, to, pageCount }`),
  `organize` and `parsePageRanges`

`ERROR_CODES` (exported, in this order):

| Code | When |
|---|---|
| `PDF_ENCRYPTED` | input PDF is encrypted / password-protected |
| `PDF_INVALID` | not a PDF, broken PDF, no pages, or wrong argument type (bytes not a `Uint8Array`, empty list, bad `imagesToPdf` options); details `{ reason: 'image' }` when a JPEG image inside the PDF cannot be cleaned (see Security) |
| `PAGE_RANGE` | bad range string (malformed, or longer than 1 000 000 characters: `{ maxLength }`), page/index out of range, bad `organize` ops or rotation |
| `TOO_LARGE` | a file > `MAX_FILE_BYTES` or all files > `MAX_TOTAL_BYTES` (details `{ max }`), or decompressed PDF streams > `MAX_DECOMPRESSED_BYTES` (details `{ reason: 'decompressed', limit }`) |
| `TOO_MANY_PAGES` | result (or one `split` part) would exceed `MAX_PAGES` (details `{ max }`; split part: `{ limit: 'part', max, part, pages }`); `split` parts together exceed `MAX_SPLIT_TOTAL_PAGES` (`{ limit: 'total', max, total }`); `parsePageRanges` groups exceed `maxTotal` (`{ max, total }`) |
| `TOO_MANY_FILES` | more than `MAX_FILES` items, or `split` would produce more than `MAX_SPLIT_PARTS` parts (`{ limit: 'parts', max, parts }`) |
| `IMAGE_TOO_LARGE` | image header says more than `MAX_IMAGE_PIXELS` |
| `UNSUPPORTED_IMAGE` | not JPEG or PNG (by magic bytes) |
| `IMAGE_INVALID` | JPEG/PNG signature present but the file is corrupt or cannot be decoded |

## Security

Agreed with QA/Security and Counsel; covered by tests in `test/`.

- Input PDFs are loaded with pdf-lib **default options**; `ignoreEncryption` is never set.
  Encrypted -> `PDF_ENCRYPTED`, any other parse failure -> `PDF_INVALID`.
- Every output is a new document (`PDFDocument.create()` + `copyPages`):
  - no Info dictionary at all (no Producer/Creator/Author/Title/Subject/Keywords/dates);
  - catalog holds only `/Type` and `/Pages`: no XMP `/Metadata`, `/Names` (document
    JavaScript, embedded files), `/AcroForm`, `/OpenAction`, outlines.
- Every copied page is cleaned **before** copying, so removed objects are never written:
  - the page dict keeps only an ALLOWLIST of keys: `/Type`, `/Resources`, `/MediaBox`,
    `/CropBox`, `/BleedBox`, `/TrimBox`, `/ArtBox`, `/Contents`, `/Rotate`, `/Annots`
    (rebuilt, below), `/UserUnit`, `/Group`. Everything else (`/AA`, `/Metadata`,
    `/PieceInfo`, `/AF`, `/Thumb`, `/B`, `/StructParents`, `/ID`, `/PZ`, `/SeparationInfo`,
    private keys) is removed. Inherited `/Resources`, `/MediaBox`, `/CropBox`, `/Rotate`
    are moved onto the page first and cleaned like the page's own;
  - every `/Resources` dict reachable from the page (page, Form XObjects, tiling patterns,
    Type3 fonts, soft-mask groups, recursively) keeps only `/Font`, `/XObject`,
    `/ExtGState`, `/ColorSpace`, `/Pattern`, `/Shading`, `/ProcSet`. `/Properties` is
    dropped: it only feeds marked / optional content, which has no effect without the
    catalog `/OCProperties` and `/StructTreeRoot` (never copied), so rendering is unchanged;
  - for dictionaries recognised by type, dicts below `/Resources` keep only per-type
    ALLOWLISTS of keys (private and unknown keys are removed, including any stream or dict
    they point to); dictionaries not recognised by type are kept as described in the
    'Other page-description data' paragraph below:
    - Font: `/Type /Subtype /BaseFont /Name /FirstChar /LastChar /Widths /FontDescriptor
      /Encoding /ToUnicode /DescendantFonts /CIDSystemInfo /DW /W /DW2 /W2 /CIDToGIDMap
      /FontBBox /FontMatrix /CharProcs /Resources`;
    - FontDescriptor: `/Type /FontName /FontFamily /FontStretch /FontWeight /Flags
      /FontBBox /ItalicAngle /Ascent /Descent /Leading /CapHeight /XHeight /StemV /StemH
      /AvgWidth /MaxWidth /MissingWidth /FontFile /FontFile2 /FontFile3 /CharSet /Style
      /Lang /FD /CIDSet`;
    - ExtGState: `/Type /LW /LC /LJ /ML /D /RI /OP /op /OPM /Font /BG /BG2 /UCR /UCR2 /TR
      /TR2 /HT /HTO /FL /SM /SA /BM /SMask /CA /ca /AIS /TK /UseBlackPtComp`; its soft-mask
      dict: `/Type /S /G /BC /TR`;
    - Form XObject: `/Type /Subtype /FormType /BBox /Matrix /Resources /Group /Length
      /Filter /DecodeParms /DL` (so `/Ref`, `/OC`, `/F` external streams, `/LastModified`,
      `/Measure`, `/PtData` and private keys are removed);
    - transparency group (page and Form `/Group`): `/Type /S /CS /I /K`;
    - Image XObject (for dictionaries recognised by type, also soft masks / stencil
      masks with `/Subtype /Image`): `/Type /Subtype /Width /Height
      /ColorSpace /BitsPerComponent /Intent /ImageMask /Mask /Decode /Interpolate /SMask
      /SMaskInData /Matte /Length /Filter /DecodeParms /DL` (so `/Alternates`, `/Name`,
      `/Metadata`, `/OPI`, `/OC`, `/ID`, `/StructParent` and private keys are removed);
    - color space parameters: ICCBased stream `/N /Alternate /Range /Length /Filter
      /DecodeParms /DL`; CalGray/CalRGB/Lab dict `/WhitePoint /BlackPoint /Gamma /Matrix
      /Range`; DeviceN attributes `/Subtype /Colorants /Process /MixingHints`;
    - Pattern: `/Type /PatternType /PaintType /TilingType /BBox /XStep /YStep /Resources
      /Matrix /Shading /ExtGState` (+ stream keys);
    - Shading: `/ShadingType /ColorSpace /Background /BBox /AntiAlias /Coords /Domain
      /Function /Extend /Matrix /BitsPerCoordinate /BitsPerComponent /BitsPerFlag /Decode
      /VerticesPerRow` (+ stream keys);
    - Function (tint transforms, shading functions): `/FunctionType /Domain /Range /Size
      /BitsPerSample /Order /Encode /Decode /C0 /C1 /N /Functions /Bounds` (+ stream keys).
    `/XObject` entries that are not a stream with `/Subtype /Image` or `/Subtype /Form`
    (PostScript `/Subtype /PS` XObjects, XObjects with a missing or unknown `/Subtype`)
    are removed;
  - residual non-metadata streams and dicts that are KEPT because rendering needs them,
    with only the forbidden-key and dangerous-object removal below (their bytes are copied
    as-is and could carry private data). Kept data includes, for example:
    1. font programs: FontDescriptor `/FontFile`, `/FontFile2`, `/FontFile3` streams;
    2. Font `/ToUnicode` CMap streams;
    3. Indexed colour space lookup table (string or stream);
    4. ExtGState `/HT` halftone dicts and streams (including halftones nested inside them);
    5. DeviceN attributes `/Process` and `/MixingHints` dicts (contents not allowlisted);
    6. Type3 font `/CharProcs` dict (every glyph procedure stream in it) and Font
       `/Encoding` dicts (Type3 and other fonts);
    7. CIDFont `/CIDToGIDMap` stream, FontDescriptor `/CIDSet` stream, `/FD` dict and
       Font `/CIDSystemInfo` dict;
    8. ICCBased profile data, Function stream data (sampled Type 0 tables, Type 4
       PostScript calculator code) and Shading stream data (mesh vertices);
    9. page content streams, Form XObject and tiling Pattern content, and non-JPEG image
       sample data (including JPEG 2000 boxes, see Known limits).
    Other page-description data (geometry boxes, graphics-state parameters, font
    descriptors, soft masks, transfer functions, Shading functions, ColorSpace
    parameters, unrecognised fonts and masks such as `/SMask` or `/Mask` without
    `/Subtype` or an ExtGState `/Font` font without `/Type`) is also kept; only active content
    (JavaScript, actions, launch, forms/widgets) and the document/image metadata listed
    elsewhere in this section are removed;
  - everything reachable from the kept keys is walked: `/AA`, `/A`, `/JS`, `/JavaScript`,
    `/Launch`, `/OpenAction`, `/Next`, `/URI`, `/AF`, `/EF`, `/EmbeddedFile(s)`,
    `/Metadata`, `/PieceInfo`, `/Thumb`, `/OPI`, `/Names`, `/AcroForm`, `/XFA`,
    `/StructParent(s)`, `/Annots`, `/Dest` are removed from every dict and stream dict, and
    any entry or array item that is an action dict, file specification, embedded file,
    metadata stream, annotation or page-tree node is removed (array items become `null`).
    `/Type`, `/S`, `/Subtype` and `/Filter` are resolved through indirect references before
    they are compared, so `/S 10 0 R` pointing to `/Launch` is caught like `/S /Launch`.
    A reference that cannot be followed because its chain is longer than 32 hops or cyclic
    anywhere in the walked graph fails closed with `PDF_INVALID` `{ reason: 'refchain' }`;
    references to missing objects are treated as null (the reference may remain, with no
    data), as the PDF standard requires (ISO 32000-1, 7.3.10); nothing that was not walked is copied;
  - every stream whose filter chain contains `DCTDecode` (whatever its `/Subtype`:
    image, soft mask, missing or indirect) is cleaned with the same
    `stripJpeg` as `imagesToPdf`: EXIF/GPS, XMP, IPTC, COM and other APPn are removed,
    APP0, ICC `APP2` and Adobe `APP14` are kept, entropy-coded data is unchanged (no
    re-encoding). If Flate/LZW/ASCII85/ASCIIHex/RunLength filters sit in front of
    `DCTDecode`, they are decoded (under `MAX_DECOMPRESSED_BYTES`) and the stream is stored
    as plain `/DCTDecode`. Any other chain, or a JPEG that cannot be parsed, fails closed
    with `PDF_INVALID` `{ reason: 'image' }` instead of being copied with its metadata;
  - `/Annots` keeps only `Link` annotations whose action is a single `URI` action with an
    `http:`, `https:` or `mailto:` URI, rebuilt as a fresh minimal dict
    (`/Type /Subtype /Rect /Border /A`). Dropped: Widgets (form fields), anything with
    `/AA`, JavaScript, Launch, SubmitForm, ImportData, GoToR, GoToE, chained `/Next`
    actions, `javascript:` URIs, internal `/Dest` links (they would pull other pages,
    including deleted ones, into the file), markup annotations (author names, popups) and
    file attachments.
- Images: see `imagesToPdf` (header-first size check, metadata removal).
- Decompression bombs: pdf-lib inflates object streams and xref streams while parsing,
  without limits. `/Type` is resolved if it is an indirect reference; a stream whose
  `/Type` is a reference that cannot be resolved yet is treated the same way (decoded under
  the budget), so no parse-time inflation escapes the cap. The core hooks the parser so these streams are first measured with a
  streaming inflater (pako, 64 KiB chunks, output discarded) and only decoded when they fit
  the remaining `MAX_DECOMPRESSED_BYTES` budget of the call; otherwise the call throws
  `TOO_LARGE` `{ reason: 'decompressed', limit }` (a 1 GiB object stream fails in ~1.5 s
  with ~200 MB peak RSS). Content streams are copied without being decoded.
- Known limits (not cleaned): the residual streams listed above, metadata inside JPEG 2000 (`JPXDecode`) boxes and inside
  inline images (`BI ... ID ... EI` in content streams), and text in content streams
  themselves. PNG decoding in `imagesToPdf` is bounded by `MAX_IMAGE_PIXELS`, not by
  `MAX_DECOMPRESSED_BYTES`.

Console output: on broken input pdf-lib writes parser warnings with `console.warn`
(stderr). pdf-lib 1.17.1 has one `console.log` (stdout) call site, in its `es` and `cjs` builds:
`FlateStream.getCode` has `if (typeof codes === 'number') console.log('FLATE:', code)`.
`codes` is always an `Int32Array` (fixed Huffman tables or `generateHuffmanTable`), so
this line cannot run; the core does not patch `console` (that would be global state and
would also swallow output of concurrent code). `test/stdout.test.mjs` runs every operation
on broken inputs, including 40 object streams with garbage Flate data that drive the
decoder, in a child process and asserts stdout is empty; it also fails if a pdf-lib
upgrade adds or changes any `console.log`. So stdio-based servers are not affected by
the core; they should still route their own logging to stderr.

## Tests

```sh
npm ci
npm test            # node --test test/*.test.mjs
npm run fixtures    # optional: write fixtures to test/fixtures/out/ for manual inspection
```

Fixtures are generated in code by `test/fixtures/gen.mjs`, exported as the package
subpath `@local-pdf-tools/core/fixtures` (Node only, uses `node:zlib`). They include a
hand-written PDF with a Standard-security `/Encrypt` dict in the trailer (pdf-lib cannot
encrypt), PDFs with an object stream of garbage Flate data, a PDF with metadata, XMP, JavaScript, actions, a form field, page `/AA`,
attachments and annotations, JPEGs with EXIF GPS and all 8 orientations, a JPEG with
ICC/Adobe segments, a PNG with text/EXIF chunks, oversized image headers and corrupt bytes.
The EXIF GPS canary is a synthetic, non-zero location (N 12°34'56.789", E 65°7'6.543").

`test/qa-regression.test.mjs` replays the adversarial QA suite (encryption variants,
JavaScript/Launch/URI tricks, attachments, XObject metadata, JPEGs with EXIF inside PDFs,
broken/cyclic/deep PDFs, limits, ranges, image options) on the small synthetic files in
`test/qa/fixtures/` (test-only, not in the npm package) and checks every output for
leftover active content, metadata and JPEG APPn/COM segments.

## License

MIT, see [LICENSE](LICENSE). Third-party notices: [THIRD-PARTY.md](THIRD-PARTY.md).
