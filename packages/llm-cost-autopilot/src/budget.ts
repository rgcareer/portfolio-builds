// A read-only spend gauge over the shared Ledger, for the `budget` CLI command and for any
// caller that wants to check spend before doing more work. It does not enforce anything
// itself — callLlm's own pre-call ceiling check does that — this just reports a level.

import { Ledger } from '@portfolio-builds/shared';

export type BudgetLevel = 'ok' | 'warn' | 'critical' | 'stop';

export interface BudgetStatus {
  spent: number;
  cap: number;
  level: BudgetLevel;
}

export class BudgetGuard {
  readonly capUsd: number;
  readonly ledger: Ledger;
  readonly thresholds: readonly [number, number, number];

  constructor(capUsd: number, ledger: Ledger, thresholds: readonly [number, number, number] = [0.5, 0.8, 1.0]) {
    this.capUsd = capUsd;
    this.ledger = ledger;
    this.thresholds = thresholds;
  }

  status(): BudgetStatus {
    const spent = this.ledger.totalCostUsd();
    if (this.capUsd <= 0) return { spent, cap: this.capUsd, level: spent > 0 ? 'stop' : 'ok' };

    const [warnAt, criticalAt, stopAt] = this.thresholds;
    const ratio = spent / this.capUsd;
    let level: BudgetLevel = 'ok';
    if (ratio >= stopAt) level = 'stop';
    else if (ratio >= criticalAt) level = 'critical';
    else if (ratio >= warnAt) level = 'warn';
    return { spent, cap: this.capUsd, level };
  }
}
