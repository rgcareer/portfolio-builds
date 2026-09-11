// Wilson score interval for a binomial proportion. The published stats floor for every
// piece: a proportion is never printed without its interval, and a delta is claimed only
// when the interval excludes zero.

/** z for a two-sided 95% interval. */
export const Z95 = 1.959963984540054;

export interface WilsonInterval {
  /** point estimate k/n */
  p: number;
  lo: number;
  hi: number;
  k: number;
  n: number;
  z: number;
}

/**
 * Wilson interval on [0, 1]. Throws on n <= 0 or k outside [0, n]: a proportion with no
 * denominator is not a number we are allowed to print.
 */
export function wilson(k: number, n: number, z: number = Z95): WilsonInterval {
  if (!Number.isInteger(k) || !Number.isInteger(n)) throw new Error(`wilson: k and n must be integers (k=${k}, n=${n})`);
  if (n <= 0) throw new Error(`wilson: n must be > 0 (n=${n})`);
  if (k < 0 || k > n) throw new Error(`wilson: k must be in [0, n] (k=${k}, n=${n})`);
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // At the boundaries the bound is exactly 0 or 1 by construction; floating point lands a
  // few ulps inside, so pin them rather than print 0.9999999999999999.
  const lo = k === 0 ? 0 : Math.max(0, center - half);
  const hi = k === n ? 1 : Math.min(1, center + half);
  return { p, lo, hi, k, n, z };
}

/** Round a proportion to a percentage with `decimals` places (integer-space rounding). */
export function toPct(x: number, decimals = 1): number {
  const scale = 10 ** decimals;
  return Math.round(x * 100 * scale) / scale;
}

/** Percent strings for a headline: { p: "50.0", lo: "36.6", hi: "63.4" }. */
export function wilsonPctStrings(k: number, n: number, decimals = 1): { p: string; lo: string; hi: string } {
  const w = wilson(k, n);
  return { p: toPct(w.p, decimals).toFixed(decimals), lo: toPct(w.lo, decimals).toFixed(decimals), hi: toPct(w.hi, decimals).toFixed(decimals) };
}
