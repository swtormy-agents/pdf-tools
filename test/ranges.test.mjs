import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePageRanges } from '../src/index.js';
import { expectCode } from './helpers.mjs';

test('basic ranges', () => {
  assert.deepEqual(parsePageRanges('1-3,5', 10), [[0, 1, 2], [4]]);
  assert.deepEqual(parsePageRanges('7', 10), [[6]]);
  assert.deepEqual(parsePageRanges('8-', 10), [[7, 8, 9]]);
  assert.deepEqual(parsePageRanges('-2', 10), [[0, 1]]);
  assert.deepEqual(parsePageRanges('3-3', 10), [[2]]);
  assert.deepEqual(parsePageRanges('1,2,', 10), [[0], [1]]);
  assert.deepEqual(parsePageRanges('2,,4', 10), [[1], [3]]);
});

test('linguist separators: fullwidth comma, en dash, tilde, spaces', () => {
  const want = [[0, 1, 2], [4]];
  for (const spec of ['1–3，5', '1~3,5', '1～3，5', '1 - 3 , 5', ' 1 – 3 ， 5 ', '1\u3000-\u30003\uFF0C5', '1 ~ 3，  5', '1\u20133,5']) {
    assert.deepEqual(parsePageRanges(spec, 10), want, JSON.stringify(spec));
  }
  assert.deepEqual(parsePageRanges('2–', 4), [[1, 2, 3]]);
  assert.deepEqual(parsePageRanges('~2', 4), [[0, 1]]);
});

test('invalid ranges -> PAGE_RANGE', async () => {
  for (const spec of ['', '   ', ',', '，', '0', '11', '4-2', '3–1', '1-2-3', 'a', '-', '–', '1.5', '1-99', '1;2', '１', null, 5]) {
    await expectCode(() => parsePageRanges(spec, 10), 'PAGE_RANGE');
  }
  await expectCode(() => parsePageRanges('1', 0), 'PAGE_RANGE');
  await expectCode(() => parsePageRanges('1,'.repeat(500_001), 10), 'PAGE_RANGE'); // too long (> MAX_SPEC_LENGTH 1 000 000 chars)
  await expectCode(() => parsePageRanges('1,'.repeat(6000), 10), 'TOO_MANY_PAGES'); // long but valid: limit by page total
});

test('total selected pages above MAX_PAGES -> TOO_MANY_PAGES', async () => {
  await expectCode(() => parsePageRanges(Array(101).fill('1-10').join(','), 10), 'TOO_MANY_PAGES');
  assert.equal(parsePageRanges(Array(100).fill('1-10').join(','), 10).flat().length, 1000);
});

test('open ranges are valid: "-N" = 1..N, "N-" = N..last, "-1" = page 1', () => {
  assert.deepEqual(parsePageRanges('-1', 10), [[0]]);
  assert.deepEqual(parsePageRanges('-3', 10), [[0, 1, 2]]);
  assert.deepEqual(parsePageRanges('5-', 7), [[4, 5, 6]]);
  assert.deepEqual(parsePageRanges('10-', 10), [[9]]);
  assert.deepEqual(parsePageRanges('-10', 10), [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]]);
  assert.deepEqual(parsePageRanges('-1,9-', 10), [[0], [8, 9]]);
});

test('open ranges still checked against the page count', async () => {
  await expectCode(() => parsePageRanges('-11', 10), 'PAGE_RANGE');
  await expectCode(() => parsePageRanges('11-', 10), 'PAGE_RANGE');
  await expectCode(() => parsePageRanges('-0', 10), 'PAGE_RANGE');
  await expectCode(() => parsePageRanges('--1', 10), 'PAGE_RANGE');
});
