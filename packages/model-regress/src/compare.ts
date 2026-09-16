// Turns two condition runs (and an optional same-model repeat as the noise floor) into a
// paired Comparison, then applies the frozen decision rule. A difference is a regression
// only when the paired-difference CI excludes 0 AND its magnitude exceeds the same-model
// repeat's CI — otherwise it is "no detectable regression at n", reported with the minimal
// detectable effect at 80% power. Achieved n is the number of pairs where both conditions
// completed; skipped items never pad it.

import { wilson, type WilsonInterval } from '@portfolio-builds/shared';
import { pairedDifferenceCI, mcnemarExact, minDetectableEffect, type PairedDiffCI } from './stats';
import type { ConditionRun, ItemResult } from './runner';

export interface ConditionSummary {
  name: string;
  model: string;
  /** Achieved n = completed items. */
  n: number;
  k: number;
  wilson: WilsonInterval;
  costPerItem: number;
  totalCostUsd: number;
  skipped: number;
}

export interface NoiseSummary {
  nPaired: number;
  b: number;
  c: number;
  ci: PairedDiffCI;
  upperPp: number;
  /** Same-model disagreement count (b + c) — the headline's noiseK. */
  disagree: number;
}

export interface Comparison {
  a: ConditionSummary;
  b: ConditionSummary;
  nPaired: number;
  /** Passes on the paired items (same denominator nPaired) — the headline's kA/kB. */
  pairedKA: number;
  pairedKB: number;
  discordant: { b: number; c: number };
  diffPp: number;
  loPp: number;
  hiPp: number;
  ci: PairedDiffCI;
  mcnemarP: number;
  noise: NoiseSummary | null;
  costIncreasePct: number | null;
  rule: string | null;
}

export type Verdict = 'regression' | 'improvement' | 'no-detectable-regression' | 'inconclusive';

export interface Decision {
  verdict: Verdict;
  reasons: string[];
  mdePp: number | null;
}

export interface DecisionThresholds {
  max_drop_pp: number;
  max_cost_increase_pct: number;
}

function summarize(run: ConditionRun): ConditionSummary {
  const n = run.completed;
  return {
    name: run.name,
    model: run.model,
    n,
    k: run.k,
    wilson: n > 0 ? wilson(run.k, n) : { p: 0, lo: 0, hi: 0, k: 0, n: 0, z: 0 },
    costPerItem: n > 0 ? run.totalCostUsd / n : 0,
    totalCostUsd: run.totalCostUsd,
    skipped: run.skipped,
  };
}

interface Discordant {
  b: number;
  c: number;
  nPaired: number;
  kx: number;
  ky: number;
}

/** Paired discordant + per-condition pass counts over items completed under BOTH runs. */
function discordantCounts(x: ConditionRun, y: ConditionRun): Discordant {
  const yByIndex = new Map<number, ItemResult>(y.results.map((r) => [r.index, r]));
  let b = 0;
  let c = 0;
  let nPaired = 0;
  let kx = 0;
  let ky = 0;
  for (const rx of x.results) {
    if (rx.skipped !== null) continue;
    const ry = yByIndex.get(rx.index);
    if (!ry || ry.skipped !== null) continue;
    nPaired++;
    if (rx.passExact) kx++;
    if (ry.passExact) ky++;
    if (rx.passExact && !ry.passExact) b++;
    else if (!rx.passExact && ry.passExact) c++;
  }
  return { b, c, nPaired, kx, ky };
}

export function compare(a: ConditionRun, b: ConditionRun, noise?: ConditionRun, rule?: string): Comparison {
  const { b: db, c: dc, nPaired, kx: pairedKA, ky: pairedKB } = discordantCounts(a, b);
  const ci = pairedDifferenceCI(db, dc, Math.max(1, nPaired));
  const diffPp = nPaired > 0 ? ci.diff * 100 : 0;

  let noiseSummary: NoiseSummary | null = null;
  if (noise) {
    const nd = discordantCounts(a, noise);
    const nci = pairedDifferenceCI(nd.b, nd.c, Math.max(1, nd.nPaired));
    noiseSummary = {
      nPaired: nd.nPaired,
      b: nd.b,
      c: nd.c,
      ci: nci,
      upperPp: Math.max(Math.abs(nci.lo), Math.abs(nci.hi)) * 100,
      disagree: nd.b + nd.c,
    };
  }

  const sa = summarize(a);
  const sb = summarize(b);
  const costIncreasePct = sa.costPerItem > 0 ? ((sb.costPerItem - sa.costPerItem) / sa.costPerItem) * 100 : null;

  return {
    a: sa,
    b: sb,
    nPaired,
    pairedKA,
    pairedKB,
    discordant: { b: db, c: dc },
    diffPp,
    loPp: ci.lo * 100,
    hiPp: ci.hi * 100,
    ci,
    mcnemarP: mcnemarExact(db, dc),
    noise: noiseSummary,
    costIncreasePct,
    rule: rule ?? null,
  };
}

/** The frozen decision rule → a verdict. Thresholds only enrich the reasons. */
export function decide(cmp: Comparison, thresholds?: DecisionThresholds): Decision {
  const reasons: string[] = [];
  if (cmp.nPaired === 0) return { verdict: 'inconclusive', reasons: ['no paired items completed'], mdePp: null };

  const excludes0 = cmp.ci.lo > 0 || cmp.ci.hi < 0;
  const discordantRate = (cmp.discordant.b + cmp.discordant.c) / cmp.nPaired;
  const mdePp = minDetectableEffect(cmp.nPaired, discordantRate);

  if (!cmp.noise) {
    if (excludes0) {
      reasons.push(`paired-difference 95% CI (${cmp.loPp.toFixed(1)} to ${cmp.hiPp.toFixed(1)} pp) excludes 0, but no same-model repeat was supplied to qualify it against the noise floor`);
      return { verdict: 'inconclusive', reasons, mdePp };
    }
    reasons.push(`paired-difference 95% CI (${cmp.loPp.toFixed(1)} to ${cmp.hiPp.toFixed(1)} pp) includes 0`);
    reasons.push(`no detectable regression at n=${cmp.nPaired}; minimal detectable effect ${mdePp.toFixed(1)} pp at 80% power`);
    return { verdict: 'no-detectable-regression', reasons, mdePp };
  }

  const exceedsNoise = Math.abs(cmp.diffPp) > cmp.noise.upperPp;
  if (excludes0 && exceedsNoise) {
    reasons.push(`paired-difference 95% CI (${cmp.loPp.toFixed(1)} to ${cmp.hiPp.toFixed(1)} pp) excludes 0 and |${cmp.diffPp.toFixed(1)}| pp exceeds the same-model repeat CI upper bound of ${cmp.noise.upperPp.toFixed(1)} pp`);
    const verdict: Verdict = cmp.diffPp > 0 ? 'regression' : 'improvement';
    if (thresholds && cmp.diffPp > thresholds.max_drop_pp) reasons.push(`observed drop ${cmp.diffPp.toFixed(1)} pp exceeds max_drop_pp ${thresholds.max_drop_pp}`);
    return { verdict, reasons, mdePp };
  }

  if (excludes0 && !exceedsNoise) {
    reasons.push(`|${cmp.diffPp.toFixed(1)}| pp does not exceed the same-model repeat noise floor (${cmp.noise.upperPp.toFixed(1)} pp); difference is within same-model noise`);
  } else {
    reasons.push(`paired-difference 95% CI (${cmp.loPp.toFixed(1)} to ${cmp.hiPp.toFixed(1)} pp) includes 0`);
  }
  reasons.push(`no detectable regression at n=${cmp.nPaired}; minimal detectable effect ${mdePp.toFixed(1)} pp at 80% power`);
  return { verdict: 'no-detectable-regression', reasons, mdePp };
}
