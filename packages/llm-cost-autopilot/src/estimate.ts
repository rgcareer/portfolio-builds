// Pre-call cost estimation for a planned batch of calls, via shared's own conservative
// ceiling formula (never a locally re-derived one) so the "estimate" and the gateway's own
// spend-cap check can never silently disagree.

import { estimateCostCeilingUsd } from '@portfolio-builds/shared';

export interface PlannedCall {
  model: string;
  inputChars: number;
  maxOutputTokens: number;
}

export interface EstimateResult {
  /** Sum of estimateCostCeilingUsd over every planned call — a ceiling, not a forecast. */
  ceilingUsd: number;
  perModel: Record<string, number>;
}

export function estimateStep(calls: readonly PlannedCall[]): EstimateResult {
  const perModel: Record<string, number> = {};
  let ceilingUsd = 0;
  for (const c of calls) {
    const usd = estimateCostCeilingUsd(c.model, c.inputChars, c.maxOutputTokens);
    perModel[c.model] = (perModel[c.model] ?? 0) + usd;
    ceilingUsd += usd;
  }
  return { ceilingUsd, perModel };
}
