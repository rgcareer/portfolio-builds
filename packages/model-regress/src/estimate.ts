// Pre-call cost estimation for a condition run. Two numbers per run: an EXPECTED cost
// (input at ~4 chars/token, output at half the budget) and a CEILING (input at 3 chars/token,
// output at the full budget) — the ceiling uses the gateway's own `estimateCostCeilingUsd`
// so the pre-registered budget matches what the spend cap will actually enforce.

import { computeCostUsd, estimateCostCeilingUsd } from '@portfolio-builds/shared';
import type { GoldenItem } from './golden';

export interface EstimateTask {
  system: string;
  maxTokens: number;
}

export interface RunEstimate {
  expectedUsd: number;
  ceilingUsd: number;
  calls: number;
}

const DEFAULT_TASK: EstimateTask = { system: '', maxTokens: 400 };

/** Estimate the cost of running `set` once under `model` for the given task. */
export function estimateRun(set: readonly GoldenItem[], model: string, task: EstimateTask = DEFAULT_TASK): RunEstimate {
  let expectedUsd = 0;
  let ceilingUsd = 0;
  for (const item of set) {
    const chars = task.system.length + item.prompt.length;
    const expectedInputTokens = Math.ceil(chars / 4);
    const expectedOutputTokens = Math.ceil(task.maxTokens / 2);
    expectedUsd += computeCostUsd(model, { input: expectedInputTokens, output: expectedOutputTokens });
    ceilingUsd += estimateCostCeilingUsd(model, chars, task.maxTokens);
  }
  return { expectedUsd, ceilingUsd, calls: set.length };
}
