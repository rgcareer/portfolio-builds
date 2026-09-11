import { describe, it, expect } from 'vitest';
import { safetyTier, hygieneEval, verdictFor, daysBetween } from '../src/grades';
import type { Severity } from '../src/rulesSchema';

const sev = (s: Severity) => ({ severity: s });

describe('safetyTier', () => {
  it('maps worst severity to a tier', () => {
    expect(safetyTier([])).toBe('A');
    expect(safetyTier([sev('info')])).toBe('B');
    expect(safetyTier([sev('low')])).toBe('B');
    expect(safetyTier([sev('medium')])).toBe('C');
    expect(safetyTier([sev('high')])).toBe('D');
    expect(safetyTier([sev('critical')])).toBe('F');
    expect(safetyTier([sev('low'), sev('critical'), sev('medium')])).toBe('F'); // worst wins
  });
});

describe('daysBetween / hygieneEval', () => {
  const base = { snapshot_date: '2026-08-25', repo_license: 'MIT', name: 'n', description: 'a sufficiently long description here' };

  it('computes whole-day age deterministically', () => {
    expect(daysBetween('2026-08-25', '2026-08-10T00:00:00Z')).toBe(15);
  });

  it('grades a fresh, licensed skill A', () => {
    const r = hygieneEval({ ...base, repo_pushed_at: '2026-08-10T00:00:00Z', repo_archived: false });
    expect(r.tier).toBe('A');
    expect(r.abandoned).toBe(false);
    expect(r.passed).toBe(5);
  });

  it('drops a skill pushed 200 days ago to B (fresh check fails)', () => {
    const r = hygieneEval({ ...base, repo_pushed_at: '2026-02-06T00:00:00Z', repo_archived: false });
    expect(r.tier).toBe('B');
    expect(r.abandoned).toBe(false);
  });

  it('marks a 400-day-stale skill abandoned → F', () => {
    const r = hygieneEval({ ...base, repo_pushed_at: '2025-07-01T00:00:00Z', repo_archived: false });
    expect(r.abandoned).toBe(true);
    expect(r.tier).toBe('F');
  });

  it('marks an archived skill abandoned → F regardless of push date', () => {
    const r = hygieneEval({ ...base, repo_pushed_at: '2026-08-20T00:00:00Z', repo_archived: true });
    expect(r.abandoned).toBe(true);
    expect(r.tier).toBe('F');
  });

  it('downgrades a fresh but unlicensed skill to B', () => {
    const r = hygieneEval({ ...base, repo_license: null, repo_pushed_at: '2026-08-10T00:00:00Z', repo_archived: false });
    expect(r.tier).toBe('B');
  });
});

describe('verdictFor (never Recommended in M1)', () => {
  it('Avoid on a critical safety finding', () => {
    expect(verdictFor('F', 'A')).toBe('Avoid');
  });
  it('Use with care on medium/high safety or poor hygiene', () => {
    expect(verdictFor('C', 'A')).toBe('Use with care');
    expect(verdictFor('D', 'A')).toBe('Use with care');
    expect(verdictFor('A', 'F')).toBe('Use with care');
    expect(verdictFor('B', 'D')).toBe('Use with care');
  });
  it('otherwise Not yet benchmarked (effectiveness unmeasured)', () => {
    expect(verdictFor('A', 'A')).toBe('Not yet benchmarked');
    expect(verdictFor('B', 'C')).toBe('Not yet benchmarked');
  });
  it('never returns Recommended in M1', () => {
    const combos: [Parameters<typeof verdictFor>[0], Parameters<typeof verdictFor>[1]][] = [
      ['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D'], ['F', 'F'],
    ];
    for (const [s, h] of combos) expect(verdictFor(s, h)).not.toBe('Recommended');
  });
});
