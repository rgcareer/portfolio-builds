import { describe, it, expect } from 'vitest';
import { clusterBootstrap } from '../src/bootstrap';

describe('bootstrap: clusterBootstrap', () => {
  it('is deterministic for a given seed', () => {
    const groups = [
      { billed: 1, noCache: 4 },
      { billed: 2, noCache: 8 },
      { billed: 0.5, noCache: 2 },
      { billed: 3, noCache: 6 },
    ];
    const a = clusterBootstrap(groups, 500, 20260915);
    const b = clusterBootstrap(groups, 500, 20260915);
    expect(a).toEqual(b);
  });

  it('the point estimate does not depend on the seed (it is a plug-in stat of the observed data)', () => {
    const groups = [
      { billed: 1, noCache: 4 },
      { billed: 2, noCache: 8 },
      { billed: 0.5, noCache: 2 },
      { billed: 3, noCache: 6 },
    ];
    const a = clusterBootstrap(groups, 500, 1);
    const b = clusterBootstrap(groups, 500, 2);
    expect(a.pct).toBeCloseTo(b.pct, 9);
  });

  it('the interval always contains the point estimate', () => {
    const groups = [
      { billed: 5, noCache: 5 }, // 0% saved
      { billed: 0, noCache: 10 }, // 100% saved
      { billed: 3, noCache: 6 }, // 50% saved
    ];
    const r = clusterBootstrap(groups, 1000, 42);
    expect(r.lo).toBeLessThanOrEqual(r.pct);
    expect(r.hi).toBeGreaterThanOrEqual(r.pct);
  });

  it('a single-session group is degenerate: [p, p]', () => {
    const r = clusterBootstrap([{ billed: 2, noCache: 8 }], 1000, 7);
    const p = (8 - 2) / 8;
    expect(r.pct).toBeCloseTo(p, 9);
    expect(r.lo).toBeCloseTo(p, 9);
    expect(r.hi).toBeCloseTo(p, 9);
  });

  it('throws on an empty group list', () => {
    expect(() => clusterBootstrap([], 100, 1)).toThrow();
  });

  it('the point estimate is the aggregate saved proportion across all groups', () => {
    const groups = [
      { billed: 1, noCache: 2 }, // saved 1
      { billed: 3, noCache: 6 }, // saved 3
    ];
    const r = clusterBootstrap(groups, 200, 3);
    expect(r.pct).toBeCloseTo((2 + 6 - 1 - 3) / (2 + 6), 9);
  });
});
