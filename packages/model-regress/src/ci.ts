// The `ci` gate: a Comparison + thresholds → an exit-code decision. A statistical regression
// fails; a cost-per-item increase beyond the threshold fails regardless of pass rate; and a
// statistically-clear drop beyond the tolerated magnitude fails too. Otherwise it passes.

import { compare, decide, type Comparison, type Decision, type DecisionThresholds } from './compare';
import type { ConditionRun } from './runner';

export interface CiThresholds {
  maxDropPp: number;
  maxCostIncreasePct: number;
}

export interface CiResult {
  code: 0 | 1;
  pass: boolean;
  verdict: Decision['verdict'];
  reasons: string[];
  costIncreasePct: number | null;
  diffPp: number;
  comparison: Comparison;
  decision: Decision;
}

/** Evaluate a prepared Comparison against the CI thresholds. */
export function ciFromComparison(cmp: Comparison, thresholds: CiThresholds): CiResult {
  const dThresholds: DecisionThresholds = { max_drop_pp: thresholds.maxDropPp, max_cost_increase_pct: thresholds.maxCostIncreasePct };
  const decision = decide(cmp, dThresholds);
  const reasons = [...decision.reasons];
  let fail = false;

  // Cost gate — fails regardless of pass rate.
  if (cmp.costIncreasePct !== null && cmp.costIncreasePct > thresholds.maxCostIncreasePct) {
    fail = true;
    reasons.push(`cost per item increased ${cmp.costIncreasePct.toFixed(1)}% > max_cost_increase_pct ${thresholds.maxCostIncreasePct}%`);
  }

  // Statistical regression.
  if (decision.verdict === 'regression') fail = true;

  // A statistically-clear drop beyond the tolerated magnitude.
  const excludes0 = cmp.ci.lo > 0 || cmp.ci.hi < 0;
  if (excludes0 && cmp.diffPp > thresholds.maxDropPp) {
    fail = true;
    reasons.push(`observed drop ${cmp.diffPp.toFixed(1)} pp exceeds max_drop_pp ${thresholds.maxDropPp} with a CI excluding 0`);
  }

  return {
    code: fail ? 1 : 0,
    pass: !fail,
    verdict: decision.verdict,
    reasons,
    costIncreasePct: cmp.costIncreasePct,
    diffPp: cmp.diffPp,
    comparison: cmp,
    decision,
  };
}

/** Convenience: build the Comparison from runs and evaluate the gate. */
export function ci(a: ConditionRun, b: ConditionRun, noise: ConditionRun | undefined, thresholds: CiThresholds, rule?: string): CiResult {
  return ciFromComparison(compare(a, b, noise, rule), thresholds);
}
