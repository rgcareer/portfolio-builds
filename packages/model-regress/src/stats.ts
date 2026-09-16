// Paired statistics for the regression detector. The data are n matched pairs (the same
// golden item under two conditions), so the two pass rates are correlated and the
// difference is analysed on the discordant pairs:
//   b = pass under A, fail under B
//   c = fail under A, pass under B
//   diff in pass rate = (b − c) / n
//
// The interval is Newcombe's method 10 (Wilson-based square-and-add with a correlation
// correction). Because a pair can be at most one of the two discordant types, the two
// "proportions" b/n and c/n are mutually exclusive, which fixes the correlation term φ from
// (b, c, n) alone — φ = −bc / √(b(n−b)c(n−c)). The significance test is the exact McNemar
// binomial on the b+c discordant pairs.

import { wilson, Z95, mulberry32 } from '@portfolio-builds/shared';

export interface PairedDiffCI {
  diff: number;
  lo: number;
  hi: number;
  b: number;
  c: number;
  n: number;
  z: number;
}

/** Newcombe method 10 CI for the paired difference in pass rate. */
export function pairedDifferenceCI(b: number, c: number, n: number, z: number = Z95): PairedDiffCI {
  if (!Number.isInteger(b) || !Number.isInteger(c) || !Number.isInteger(n)) {
    throw new Error(`pairedDifferenceCI: b, c, n must be integers (b=${b}, c=${c}, n=${n})`);
  }
  if (n <= 0) throw new Error(`pairedDifferenceCI: n must be > 0 (n=${n})`);
  if (b < 0 || c < 0 || b + c > n) throw new Error(`pairedDifferenceCI: need b,c >= 0 and b+c <= n (b=${b}, c=${c}, n=${n})`);

  const p1 = b / n;
  const p2 = c / n;
  const diff = (b - c) / n;
  const w1 = wilson(b, n, z);
  const w2 = wilson(c, n, z);
  const denom = Math.sqrt(b * (n - b) * c * (n - c));
  const phi = denom === 0 ? 0 : (-b * c) / denom;

  const radL = (p1 - w1.lo) ** 2 - 2 * phi * (p1 - w1.lo) * (w2.hi - p2) + (w2.hi - p2) ** 2;
  const radU = (w1.hi - p1) ** 2 - 2 * phi * (w1.hi - p1) * (p2 - w2.lo) + (p2 - w2.lo) ** 2;
  const lo = Math.max(-1, diff - Math.sqrt(Math.max(0, radL)));
  const hi = Math.min(1, diff + Math.sqrt(Math.max(0, radU)));
  return { diff, lo, hi, b, c, n, z };
}

function logFactorial(k: number): number {
  let s = 0;
  for (let i = 2; i <= k; i++) s += Math.log(i);
  return s;
}

/** Binomial coefficient C(nn, k) via log-gamma sums (exact for the small counts here). */
function choose(nn: number, k: number): number {
  if (k < 0 || k > nn) return 0;
  return Math.round(Math.exp(logFactorial(nn) - logFactorial(k) - logFactorial(nn - k)));
}

/** Exact two-sided McNemar p-value on the b+c discordant pairs (binomial, p=0.5). */
export function mcnemarExact(b: number, c: number): number {
  const m = b + c;
  if (m === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += choose(m, i);
  const p = 2 * tail * Math.pow(0.5, m);
  return Math.min(1, p);
}

export interface BootstrapResult {
  mean: number;
  lo: number;
  hi: number;
  iters: number;
}

/**
 * Percentile bootstrap CI for the paired difference. Resamples the pairs with replacement
 * using mulberry32(seed), so two runs at the same seed are bit-for-bit identical.
 */
export function pairedBootstrap(pairs: ReadonlyArray<[boolean, boolean]>, seed: number, iters: number): BootstrapResult {
  const n = pairs.length;
  if (n === 0) return { mean: 0, lo: 0, hi: 0, iters };
  const rng = mulberry32(seed);
  const deltas: number[] = new Array(iters);
  for (let it = 0; it < iters; it++) {
    let sa = 0;
    let sb = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng() * n);
      const pr = pairs[idx]!;
      if (pr[0]) sa++;
      if (pr[1]) sb++;
    }
    deltas[it] = (sa - sb) / n;
  }
  deltas.sort((x, y) => x - y);
  const mean = deltas.reduce((a, x) => a + x, 0) / iters;
  const loIdx = Math.floor(0.025 * (iters - 1));
  const hiIdx = Math.ceil(0.975 * (iters - 1));
  return { mean, lo: deltas[loIdx]!, hi: deltas[hiIdx]!, iters };
}

// Inverse standard-normal CDF (Acklam's rational approximation; error < 1.15e-9).
function invNormalCdf(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
}

/**
 * Minimal detectable effect (in percentage points) for the paired difference at the given
 * power, from a normal approximation: δ = (z_{α/2} + z_power)·√(ψ/n), where ψ is the
 * discordant-pair rate. Decreases like 1/√n.
 */
export function minDetectableEffect(n: number, discordantRate: number, power = 0.8): number {
  if (n <= 0) throw new Error(`minDetectableEffect: n must be > 0 (n=${n})`);
  const delta = (Z95 + invNormalCdf(power)) * Math.sqrt(discordantRate / n);
  return delta * 100;
}

/** Pairs needed to detect a `deltaPp` percentage-point difference at the given power. */
export function requiredN(deltaPp: number, discordantRate: number, power = 0.8): number {
  if (deltaPp <= 0) throw new Error(`requiredN: deltaPp must be > 0 (deltaPp=${deltaPp})`);
  const delta = deltaPp / 100;
  return Math.ceil(discordantRate * ((Z95 + invNormalCdf(power)) / delta) ** 2);
}
