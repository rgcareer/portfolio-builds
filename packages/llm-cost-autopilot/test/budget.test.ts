import { describe, it, expect } from 'vitest';
import { Ledger } from '@portfolio-builds/shared';
import { BudgetGuard } from '../src/budget';

function ledgerWithSpend(usd: number): Ledger {
  const ledger = new Ledger();
  if (usd > 0) ledger.insert({ provider: 'anthropic', model: 'claude-haiku-4-5', costUsd: usd, mock: false });
  return ledger;
}

describe('budget: BudgetGuard', () => {
  it('is ok below the warn threshold', () => {
    const guard = new BudgetGuard(10, ledgerWithSpend(1));
    expect(guard.status()).toEqual({ spent: 1, cap: 10, level: 'ok' });
  });

  it('alerts warn at 50%', () => {
    const guard = new BudgetGuard(10, ledgerWithSpend(5));
    expect(guard.status().level).toBe('warn');
  });

  it('alerts critical at 80%', () => {
    const guard = new BudgetGuard(10, ledgerWithSpend(8));
    expect(guard.status().level).toBe('critical');
  });

  it('stops at 100% (>= cap)', () => {
    const guard = new BudgetGuard(10, ledgerWithSpend(10));
    expect(guard.status().level).toBe('stop');
  });

  it('stops when spend exceeds the cap', () => {
    const guard = new BudgetGuard(10, ledgerWithSpend(12));
    expect(guard.status().level).toBe('stop');
  });

  it('honors custom thresholds', () => {
    const guard = new BudgetGuard(10, ledgerWithSpend(3), [0.2, 0.6, 0.9]);
    expect(guard.status().level).toBe('warn');
  });

  it('a zero cap with any real spend is stop', () => {
    const guard = new BudgetGuard(0, ledgerWithSpend(0.0001));
    expect(guard.status().level).toBe('stop');
  });

  it('a zero cap with no spend is ok', () => {
    const guard = new BudgetGuard(0, ledgerWithSpend(0));
    expect(guard.status().level).toBe('ok');
  });
});
