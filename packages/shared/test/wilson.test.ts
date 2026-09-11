import { describe, it, expect } from 'vitest';
import { wilson, wilsonPctStrings, toPct } from '../src/wilson';

describe('Wilson interval', () => {
  it('known answer: k=25, n=50 -> 36.6% to 63.4%', () => {
    expect(wilsonPctStrings(25, 50)).toEqual({ p: '50.0', lo: '36.6', hi: '63.4' });
  });
  it('known answer: k=0, n=10 -> lower bound exactly 0, upper ~27.8%', () => {
    const w = wilson(0, 10);
    expect(w.lo).toBe(0);
    expect(toPct(w.hi)).toBe(27.8);
  });
  it('known answer: k=n -> upper bound exactly 1', () => {
    expect(wilson(10, 10).hi).toBe(1);
  });
  it('interval narrows with n at fixed p', () => {
    const a = wilson(5, 10);
    const b = wilson(50, 100);
    expect(b.hi - b.lo).toBeLessThan(a.hi - a.lo);
  });
  it('refuses n=0, negative k, k>n, and non-integers', () => {
    expect(() => wilson(0, 0)).toThrow();
    expect(() => wilson(-1, 10)).toThrow();
    expect(() => wilson(11, 10)).toThrow();
    expect(() => wilson(1.5, 10)).toThrow();
  });
});
