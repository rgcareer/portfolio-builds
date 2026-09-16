// Session-level cluster bootstrap for the "% saved" confidence interval. Resamples whole
// sessions (not individual calls) with replacement — the calls within one session are not
// independent observations, so a call-level bootstrap would understate the interval.

import { mulberry32 } from '@portfolio-builds/shared';

export interface SessionCost {
  billed: number;
  noCache: number;
}

export interface BootstrapResult {
  /** Point estimate: aggregate (noCache - billed) / noCache across all groups. */
  pct: number;
  lo: number;
  hi: number;
}

function savedFraction(groups: readonly SessionCost[]): number {
  let billed = 0;
  let noCache = 0;
  for (const g of groups) {
    billed += g.billed;
    noCache += g.noCache;
  }
  return noCache > 0 ? (noCache - billed) / noCache : 0;
}

function percentile(sorted: readonly number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx]!;
}

/**
 * Percentile bootstrap, B resamples of whole session groups, deterministic for a given
 * seed (mulberry32 — the only sanctioned PRNG in this repo). A single-group input is
 * degenerate: there is nothing to resample, so the interval collapses to [point, point].
 * The reported interval is widened, if needed, to always contain the point estimate.
 */
export function clusterBootstrap(groups: readonly SessionCost[], B: number, seed: number): BootstrapResult {
  if (groups.length === 0) throw new Error('clusterBootstrap: no session groups to resample');
  const point = savedFraction(groups);
  if (groups.length === 1) return { pct: point, lo: point, hi: point };

  const rng = mulberry32(seed);
  const n = groups.length;
  const samples: number[] = new Array(B);
  for (let b = 0; b < B; b++) {
    let billed = 0;
    let noCache = 0;
    for (let i = 0; i < n; i++) {
      const g = groups[Math.floor(rng() * n)]!;
      billed += g.billed;
      noCache += g.noCache;
    }
    samples[b] = noCache > 0 ? (noCache - billed) / noCache : 0;
  }
  samples.sort((a, c) => a - c);
  const lo = Math.min(percentile(samples, 0.025), point);
  const hi = Math.max(percentile(samples, 0.975), point);
  return { pct: point, lo, hi };
}
