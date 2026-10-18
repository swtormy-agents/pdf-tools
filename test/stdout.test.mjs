import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Runs every operation on broken inputs (incl. 40 object streams with garbage Flate data
// that drive pdf-lib's FlateStream decoder) in a child process and captures its stdout.
const script = `
import { pdfInfo, merge, split, organize, imagesToPdf } from '../src/index.js';
import * as fx from './fixtures/gen.mjs';
const inputs = [fx.truncatedPdf(), fx.corruptBytes(), fx.encryptedPdf(), await fx.evilPdf(), await fx.plainPdf(2)];
for (let s = 1; s <= 40; s++) inputs.push(fx.brokenFlatePdf(s));
const swallow = (p) => p.then(() => {}, () => {});
for (const b of inputs) {
  await swallow(pdfInfo(b));
  await swallow(merge([{ bytes: b }]));
  await swallow(split(b, '1'));
  await swallow(organize(b, { order: [0] }));
}
await swallow(imagesToPdf([{ bytes: fx.exifJpeg() }, { bytes: fx.metadataPng() }], { pageSize: 'A4', margin: 20 }));
await swallow(imagesToPdf([{ bytes: fx.corruptBytes() }]));
process.stderr.write('DONE');
`;

test('nothing is written to stdout (stdio MCP servers stay clean)', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: here, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stderr.endsWith('DONE'), r.stderr);
  assert.equal(r.stdout, '');
});

test('pdf-lib: the only console.log is the unreachable FLATE debug line', () => {
  // FlateStream.getCode has `if (typeof codes === 'number') console.log('FLATE:', code)`, but
  // codes is always an Int32Array (fixed tables and generateHuffmanTable), so it never fires.
  // This test fails if a pdf-lib upgrade adds or changes console.log calls.
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('pdf-lib/package.json'));
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) {
        readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          const t = line.trim();
          if (/console\.log\s*\(/.test(t) && !t.startsWith('*') && !t.startsWith('//')) hits.push(`${p.slice(root.length + 1)}:${t}`);
        });
      }
    }
  };
  walk(join(root, 'es'));
  walk(join(root, 'cjs'));
  assert.deepEqual(hits.sort(), [
    "cjs/core/streams/FlateStream.js:console.log('FLATE:', code);",
    "es/core/streams/FlateStream.js:console.log('FLATE:', code);",
  ]);
  for (const f of ['es', 'cjs']) {
    const src = readFileSync(join(root, f, 'core/streams/FlateStream.js'), 'utf8');
    assert.match(src, /if \(typeof codes === 'number'\) \{\s*console\.log\('FLATE:', code\);/);
    assert.match(src, /var codes = new Int32Array\(size\);[\s\S]*return \[codes, maxLen\];/);
  }
});
