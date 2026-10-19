# QA regression fixtures

Synthetic adversarial inputs from the QA review of core 331a28a, used by
`test/qa-regression.test.mjs`. Generated with pikepdf, reportlab, Pillow and piexif; no
third-party or real user content. `LEAK-*` strings are canaries that must not appear in
any output. EXIF GPS values (N 12°34', W 98°76') are made up. Timestamps in the PDF Info
dictionaries are fixed at UTC.

Not committed (too large; generated in the tests or covered elsewhere): 2000- and
1001-page PDFs (`fx.plainPdf`), 1 GiB - 16 GiB object-stream / content-stream Flate bombs,
deep dict and long reference chains, PNG IDAT bomb and 7000x7000 RGBA PNG.
These files are test-only and are not part of the npm package (`files` in package.json).
