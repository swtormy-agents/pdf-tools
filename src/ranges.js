import { fail } from './errors.js';
import { LIMITS } from './limits.js';

const MAX_SPEC_LENGTH = 10_000;

/**
 * Parse a 1-based page range spec into groups of 0-based page indexes.
 *
 *   parsePageRanges('1-3,5', 10)  -> [[0, 1, 2], [4]]
 *   parsePageRanges('8-', 10)     -> [[7, 8, 9]]   (open end = last page)
 *   parsePageRanges('-2', 10)     -> [[0, 1]]      (open start = page 1)
 *   parsePageRanges('-1', 10)     -> [[0]]         (page 1, not an error)
 *
 * Group separators: ',' and fullwidth '，' (U+FF0C).
 * Range dashes: '-', en dash '–' (U+2013), '~' and fullwidth '～' (U+FF5E).
 * Whitespace (incl. U+3000) is ignored anywhere. Empty groups ('1,,2', trailing ',') are skipped.
 * Throws PdfToolError PAGE_RANGE on syntax errors, reversed ranges, pages out of 1..pageCount,
 * or a spec without any group.
 *
 * @param {string} spec
 * @param {number} pageCount
 * @param {number} [maxTotal=LIMITS.MAX_PAGES] max pages over all groups; above it throws TOO_MANY_PAGES
 * @returns {number[][]}
 */
export function parsePageRanges(spec, pageCount, maxTotal = LIMITS.MAX_PAGES) {
  if (typeof spec !== 'string') fail('PAGE_RANGE', 'Page range must be a string');
  if (!Number.isInteger(pageCount) || pageCount < 1) fail('PAGE_RANGE', 'Document has no pages');
  if (spec.length > MAX_SPEC_LENGTH) fail('PAGE_RANGE', 'Page range is too long');
  const norm = spec
    .replace(/\s+/gu, '')
    .replace(/\uFF0C/gu, ',')
    .replace(/[\u2013~\uFF5E]/gu, '-');
  const groups = [];
  let total = 0;
  for (const part of norm.split(',')) {
    if (part === '') continue;
    const m = /^(\d*)-(\d*)$/.exec(part) || /^(\d+)$/.exec(part);
    if (!m) fail('PAGE_RANGE', `Invalid page range "${part.slice(0, 32)}"`);
    let from;
    let to;
    if (m.length === 2) {
      from = to = Number(m[1]);
    } else {
      if (m[1] === '' && m[2] === '') fail('PAGE_RANGE', 'Invalid page range "-"');
      from = m[1] === '' ? 1 : Number(m[1]);
      to = m[2] === '' ? pageCount : Number(m[2]);
    }
    if (from < 1 || to < 1 || from > pageCount || to > pageCount) {
      fail('PAGE_RANGE', `Page out of range 1-${pageCount}`, { from, to, pageCount });
    }
    if (from > to) fail('PAGE_RANGE', `Reversed page range ${from}-${to}`, { from, to });
    total += to - from + 1;
    if (total > maxTotal) fail('TOO_MANY_PAGES', `More than ${maxTotal} pages selected`, { max: maxTotal, total });
    const g = [];
    for (let p = from; p <= to; p++) g.push(p - 1);
    groups.push(g);
  }
  if (groups.length === 0) fail('PAGE_RANGE', 'Empty page range');
  return groups;
}
