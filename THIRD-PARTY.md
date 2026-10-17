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
