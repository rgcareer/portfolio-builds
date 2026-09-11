import { describe, it, expect } from 'vitest';
import { renderHeadline, templatePlaceholders, HeadlineError } from '../src/headline';
import { stableStringify, canonicalize, pct, sha256Canonical } from '../src/stableJson';

describe('headline renderer', () => {
  const t = 'Of {n} quickstarts, {k} ({p}%, CI {lo}-{hi}%) state a milestone.';
  it('lists placeholders in order of first appearance', () => {
    expect(templatePlaceholders(t)).toEqual(['n', 'k', 'p', 'lo', 'hi']);
  });
  it('renders when every value is measured', () => {
    expect(renderHeadline(t, { n: 50, k: 25, p: '50.0', lo: '36.6', hi: '63.4' })).toBe(
      'Of 50 quickstarts, 25 (50.0%, CI 36.6-63.4%) state a milestone.',
    );
  });
  it('refuses an unresolved placeholder', () => {
    expect(() => renderHeadline(t, { n: 50, k: 25, p: '50.0', lo: '36.6' })).toThrow(HeadlineError);
    expect(() => renderHeadline(t, { n: 50, k: 25, p: '50.0', lo: '36.6' })).toThrow(/hi/);
  });
  it('refuses null, undefined, NaN, Infinity, and empty strings', () => {
    expect(() => renderHeadline('{a}', { a: null })).toThrow(HeadlineError);
    expect(() => renderHeadline('{a}', { a: undefined })).toThrow(HeadlineError);
    expect(() => renderHeadline('{a}', { a: Number.NaN })).toThrow(HeadlineError);
    expect(() => renderHeadline('{a}', { a: Number.POSITIVE_INFINITY })).toThrow(HeadlineError);
    expect(() => renderHeadline('{a}', { a: '' })).toThrow(HeadlineError);
  });
  it('refuses values that are themselves placeholders (TBD, TODO, X%, N=)', () => {
    for (const v of ['TBD', 'todo', 'X', 'X%', 'N=', 'xx', '???', 'n/a']) {
      expect(() => renderHeadline('{a}', { a: v })).toThrow(HeadlineError);
    }
  });
  it('refuses a value that smuggles a placeholder back in', () => {
    expect(() => renderHeadline('{a}', { a: '{b}' })).toThrow(HeadlineError);
  });
});

describe('canonical JSON', () => {
  it('sorts keys recursively and preserves array order', () => {
    const s = stableStringify({ b: 1, a: { d: [3, 1, 2], c: null } });
    expect(s).toBe('{\n  "a": {\n    "c": null,\n    "d": [\n      3,\n      1,\n      2\n    ]\n  },\n  "b": 1\n}\n');
    expect(canonicalize({ z: 1, y: 2 })).toEqual({ y: 2, z: 1 });
  });
  it('hashes are order-independent', () => {
    expect(sha256Canonical({ a: 1, b: 2 })).toBe(sha256Canonical({ b: 2, a: 1 }));
  });
  it('pct rounds in integer space and returns 0 for a zero denominator', () => {
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(1, 3, 2)).toBe(33.33);
    expect(pct(2, 3)).toBe(66.7);
    expect(pct(0, 0)).toBe(0);
  });
});
