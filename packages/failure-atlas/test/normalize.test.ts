import { describe, it, expect } from 'vitest';
import { atomize, normalizeMessage, templatize, cluster, isOperatorAnnotation } from '../src/normalize';
import { makeTokenizer } from '@portfolio-builds/shared';

// Fixture strings mirror the SHAPES observed in the source logs (structure, not content).
const tok = makeTokenizer('a-test-salt-of-sufficient-length', 'co_', 8);

describe('atomize', () => {
  it('splits a multi-board error into one atom per board with prefix', () => {
    const a = atomize('r1', '2/10 boards failed: acme.wd1/External: The operation was aborted due to timeout; globex: fetch failed');
    expect(a).toEqual([
      { sourceId: 'r1', board: 'acme.wd1/External', message: 'The operation was aborted due to timeout' },
      { sourceId: 'r1', board: 'globex', message: 'fetch failed' },
    ]);
  });
  it('keeps a single-board error as one atom without prefix parsing of the message', () => {
    expect(atomize('r2', 'ashby: rate limited (429) after 3 attempts')).toEqual([{ sourceId: 'r2', board: null, message: 'ashby: rate limited (429) after 3 attempts' }]);
    expect(atomize('r3', 'fetch failed')).toEqual([{ sourceId: 'r3', board: null, message: 'fetch failed' }]);
  });
  it('handles "1/1 boards failed" with a message containing colons', () => {
    expect(atomize('r4', '1/1 boards failed: initech: lever: HTTP 404')).toEqual([{ sourceId: 'r4', board: 'initech', message: 'lever: HTTP 404' }]);
  });
});

describe('normalizeMessage', () => {
  it('replaces tenants, timestamps, uuids, and free digits; keeps HTTP status codes literal', () => {
    expect(normalizeMessage('acme.wd1/External: HTTP 422')).toBe('<tenant>: HTTP 422');
    expect(normalizeMessage('rate limited (429) after 3 attempts')).toBe('rate limited (429) after <n> attempts');
    expect(normalizeMessage('0 jobs across 15 terms')).toBe('<n> jobs across <n> terms');
    expect(normalizeMessage('closed by 2026-07-14 audit session')).toBe('closed by <ts> audit session');
    expect(normalizeMessage('run 123e4567-e89b-12d3-a456-426614174000 aborted')).toBe('run <uuid> aborted');
    expect(normalizeMessage("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON")).toBe("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON");
  });
  it('is idempotent', () => {
    const s = normalizeMessage('adzuna: HTTP 503 at 2026-06-19T10:00:00Z after 2 tries');
    expect(normalizeMessage(s)).toBe(s);
  });
});

describe('templatize + cluster', () => {
  it('groups by exact template, counts records and employer tokens, keeps two redacted examples, sorts by count', () => {
    const rows = [
      { id: 'a', at: '2026-06-10', error: '1/10 boards failed: acme.wd1/External: 0 jobs across 15 terms' },
      { id: 'b', at: '2026-06-11', error: '1/10 boards failed: acme.wd1/External: 0 jobs across 12 terms' },
      { id: 'c', at: '2026-06-12', error: '2/2 boards failed: globex: fetch failed; initech: fetch failed' },
      { id: 'd', at: '2026-06-09', error: 'adzuna: HTTP 503' },
    ];
    const items = rows.flatMap((r) => atomize(r.id, r.error).map((atom) => ({ t: templatize(atom, tok), at: r.at })));
    const cs = cluster(items);
    expect(cs.map((c) => [c.template, c.count, c.records, c.employerTokens])).toEqual([
      ['<n> jobs across <n> terms', 2, 2, 1],
      ['fetch failed', 2, 1, 2],
      ['adzuna: HTTP 503', 1, 1, 0],
    ]);
    expect(cs[0]!.firstSeen).toBe('2026-06-10');
    expect(cs[0]!.lastSeen).toBe('2026-06-11');
    expect(cs[0]!.examples[0]).toMatch(/^co_[0-9a-f]{8}: 0 jobs across 15 terms$/);
    expect(cs[1]!.examples.join(' ')).not.toContain('globex');
    expect(cs[0]!.clusterId).toMatch(/^[0-9a-f]{8}$/);
  });
  it('the same template yields the same cluster id across runs', () => {
    const a = templatize({ sourceId: 'x', board: null, message: 'adzuna: HTTP 503' }, tok).clusterId;
    const b = templatize({ sourceId: 'y', board: null, message: 'adzuna: HTTP 503' }, tok).clusterId;
    expect(a).toBe(b);
  });
});

describe('operator annotations', () => {
  it('recognizes human cleanup notes and nothing else', () => {
    expect(isOperatorAnnotation('crash orphan — closed by 2026-07-14 audit session')).toBe(true);
    expect(isOperatorAnnotation('stale/aborted run (severed request or test) — cleaned up 2026-06-19')).toBe(true);
    expect(isOperatorAnnotation('fetch failed')).toBe(false);
    expect(isOperatorAnnotation('interrupted (process restart)')).toBe(false);
  });
});
