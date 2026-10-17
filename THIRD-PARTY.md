# Third-party software

`@local-pdf-tools/core` has one direct runtime dependency, `pdf-lib`, pinned to an exact
version. The full runtime dependency tree (from `package-lock.json`) is:

| Package | Version | License | Copyright | Source |
|---|---|---|---|---|
| pdf-lib | 1.17.1 | MIT | Copyright (c) 2019 Andrew Dillon | https://github.com/Hopding/pdf-lib |
| @pdf-lib/standard-fonts | 1.0.0 | MIT | Copyright (c) 2018 Andrew Dillon | https://github.com/Hopding/standard-fonts |
| @pdf-lib/upng | 1.0.1 | MIT | Copyright (c) 2017 Photopea | https://github.com/Hopding/upng |
| pako | 1.0.11 | MIT AND Zlib | Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn | https://github.com/nodeca/pako |
| tslib | 1.14.1 | 0BSD | Copyright (c) Microsoft Corporation | https://github.com/Microsoft/tslib |

Notes

- `pako` is a port of zlib; its license file covers both the MIT port and the Zlib-licensed
  original code.
- `@pdf-lib/standard-fonts` contains metrics for the 14 PDF standard fonts. The core does not
  draw text, but the package is installed as a pdf-lib dependency.
- Products that bundle the core (web pages, MCP server) must show these notices, e.g. on a
  licenses page, together with the MIT notice of this repository (`LICENSE`).
- Dev/test tooling: none. Tests use only Node's built-in `node:test`, `node:assert` and
  `node:zlib`.

## Bundled / nested notices

The texts below are taken from files under `node_modules` after `npm install` (or, for
`base64-arraybuffer`, from its published `LICENSE-MIT`, matching the copyright line
embedded in `pdf-lib` and `@pdf-lib/standard-fonts`).

### base64-arraybuffer (MIT)

Bundled in `pdf-lib` (`src/utils/base64.ts` / `es/utils/base64.js`) and
`@pdf-lib/standard-fonts` (`lib/utils.js` / `es/utils.js`):

> Copyright (c) 2012 Niklas von Hertzen
> Licensed under the MIT license.
> https://github.com/niklasvh/base64-arraybuffer

Full MIT text (`LICENSE-MIT` of base64-arraybuffer@0.1.5, the version listed in
`@pdf-lib/standard-fonts` package.json):

```
Copyright (c) 2012 Niklas von Hertzen

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```

### pako — zlib notice (Jean-loup Gailly and Mark Adler)

Verbatim from `pako` source headers (e.g. `node_modules/pako/lib/zlib/deflate.js`,
`inflate.js`, and the other files under `lib/zlib/`):

```
(C) 1995-2013 Jean-loup Gailly and Mark Adler
(C) 2014-2017 Vitaly Puzrin and Andrey Tupitsin

This software is provided 'as-is', without any express or implied
warranty. In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
  claim that you wrote the original software. If you use this software
  in a product, an acknowledgment in the product documentation would be
  appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
  misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.
```

### Adobe font metrics (AFM) — `@pdf-lib/standard-fonts`

`Notice` fields from the compressed AFM JSON under
`node_modules/@pdf-lib/standard-fonts/lib/*.compressed.json` (decompressed),
copyright and trademark lines verbatim:

```
Copyright (c) 1989, 1990, 1991, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.
```
(Courier-Bold, Courier-BoldOblique)

```
Copyright (c) 1989, 1990, 1991, 1992, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.
```
(Courier, Courier-Oblique)

```
Copyright (c) 1985, 1987, 1989, 1990, 1997 Adobe Systems Incorporated.  All Rights Reserved.Helvetica is a trademark of Linotype-Hell AG and/or its subsidiaries.
```
(Helvetica, Helvetica-Bold, Helvetica-Oblique, Helvetica-BoldOblique)

```
Copyright (c) 1985, 1987, 1989, 1990, 1997 Adobe Systems Incorporated. All rights reserved.
```
(Symbol)

```
Copyright (c) 1985, 1987, 1989, 1990, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.Times is a trademark of Linotype-Hell AG and/or its subsidiaries.
```
(Times-Roman, Times-Bold, Times-Italic, Times-BoldItalic)

```
Copyright (c) 1985, 1987, 1988, 1989, 1997 Adobe Systems Incorporated. All Rights Reserved.ITC Zapf Dingbats is a registered trademark of International Typeface Corporation.
```
(ZapfDingbats)
