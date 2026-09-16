import { describe, it, expect } from 'vitest';
import {
  pairedDifferenceCI,
  mcnemarExact,
  pairedBootstrap,
  minDetectableEffect,
  requiredN,
} from '../src/stats';

describe('pairedDifferenceCI (Newcombe method 10, Wilson-based)', () => {
  it('is symmetric around 0 when b=c=0', () => {
    const ci = pairedDifferenceCI(0, 0, 40);
    expect(ci.diff).toBe(0);
    expect(ci.lo).toBeCloseTo(-ci.hi, 12);
    expect(ci.lo).toBeLessThan(0);
    expect(ci.hi).toBeGreaterThan(0);
    expect(ci.lo).toBeCloseTo(-0.08762160119728664, 10);
  });

  it('matches the reference computation for a textbook discordant pair (b=8, c=2, n=40)', () => {
    const ci = pairedDifferenceCI(8, 2, 40);
    expect(ci.diff).toBeCloseTo(0.15, 12);
    expect(ci.lo).toBeCloseTo(-0.007372658461636594, 10);
    expect(ci.hi).toBeCloseTo(0.3059218572048548, 10);
  });

  it('reflects sign when b and c swap', () => {
    const ci = pairedDifferenceCI(2, 8, 40);
    expect(ci.diff).toBeCloseTo(-0.15, 12);
    expect(ci.lo).toBeCloseTo(-0.3059218572048548, 10);
    expect(ci.hi).toBeCloseTo(0.007372658461636594, 10);
  });
});

describe('mcnemarExact', () => {
  it('mcnemarExact(5, 1) === 0.21875', () => {
    expect(mcnemarExact(5, 1)).toBeCloseTo(0.21875, 12);
  });
  it('is 1 when there are no discordant pairs', () => {
    expect(mcnemarExact(0, 0)).toBe(1);
  });
  it('is symmetric in its arguments', () => {
    expect(mcnemarExact(7, 3)).toBeCloseTo(mcnemarExact(3, 7), 12);
  });
});

describe('pairedBootstrap', () => {
  const pairs: [boolean, boolean][] = [
    [true, false], [true, true], [false, false], [true, true],
    [true, false], [false, true], [true, true], [true, false],
    [true, true], [false, false],
  ];
  it('is identical across two runs for the same seed', () => {
    const a = pairedBootstrap(pairs, 20260915, 2000);
    const b = pairedBootstrap(pairs, 20260915, 2000);
    expect(a).toEqual(b);
  });
  it('differs for a different seed and brackets the point difference', () => {
    const a = pairedBootstrap(pairs, 1, 2000);
    const b = pairedBootstrap(pairs, 2, 2000);
    expect(a.lo === b.lo && a.hi === b.hi).toBe(false);
    expect(a.lo).toBeLessThanOrEqual(a.mean);
    expect(a.hi).toBeGreaterThanOrEqual(a.mean);
  });
});

describe('minDetectableEffect and requiredN', () => {
  it('MDE decreases as n grows', () => {
    const small = minDetectableEffect(40, 0.2);
    const large = minDetectableEffect(160, 0.2);
    expect(small).toBeGreaterThan(large);
    expect(small).toBeCloseTo(19.81019905201251, 8);
    expect(large).toBeCloseTo(9.905099526006255, 8);
  });
  it('requiredN is monotone (larger delta needs fewer pairs)', () => {
    expect(requiredN(10, 0.2)).toBe(157);
    expect(requiredN(5, 0.2)).toBe(628);
    expect(requiredN(5, 0.2)).toBeGreaterThan(requiredN(10, 0.2));
  });
});
