import { describe, it, expect } from 'vitest';
import { compare, decide } from '../src/compare';
import { ci } from '../src/ci';
import type { ConditionRun, ItemResult } from '../src/runner';

/** Build a completed ConditionRun from a per-item passExact vector. */
function mkRun(name: string, model: string, passExact: boolean[], costPerItem = 0): ConditionRun {
  const results: ItemResult[] = passExact.map((p, i) => ({
    index: i,
    id: `WO-${1000 + i}`,
    model,
    content: '{}',
    error: null,
    costUsd: costPerItem,
    latencyMs: 1,
    usage: null,
    mock: true,
    passParse: true,
    passExact: p,
    skipped: null,
    at: '2026-09-15T00:00:00.000Z',
  }));
  const k = passExact.filter(Boolean).length;
  return {
    name,
    model,
    maxTokens: 400,
    n: passExact.length,
    completed: passExact.length,
    k,
    kParse: passExact.length,
    skipped: 0,
    errors: 0,
    totalCostUsd: costPerItem * passExact.length,
    results,
  };
}

/** A boolean[40] with `trueCount` leading trues. */
function vec(trueCount: number, n = 40): boolean[] {
  return Array.from({ length: n }, (_, i) => i < trueCount);
}

const THRESHOLDS = { maxDropPp: 5, maxCostIncreasePct: 25 }; // CiThresholds (camelCase) for ci()
const DECISION_THRESHOLDS = { max_drop_pp: 5, max_cost_increase_pct: 25 }; // DecisionThresholds (snake) for decide()

describe('compare + decide', () => {
  it('flags a regression when A beats B beyond the noise floor', () => {
    const a = mkRun('A', 'claude-sonnet-5', vec(40));
    const b = mkRun('B', 'claude-haiku-4-5', vec(25)); // A pass/B fail on 15 items
    const noise = mkRun('A-repeat', 'claude-sonnet-5', vec(40)); // identical → noise 0
    const cmp = compare(a, b, noise);
    expect(cmp.discordant).toEqual({ b: 15, c: 0 });
    expect(cmp.diffPp).toBeCloseTo(37.5, 6);
    expect(decide(cmp, DECISION_THRESHOLDS).verdict).toBe('regression');
  });

  it('flags an improvement when B beats A beyond the noise floor', () => {
    const a = mkRun('A', 'claude-sonnet-5', vec(25));
    const b = mkRun('B', 'claude-haiku-4-5', vec(40)); // A fail/B pass on 15 items
    const noise = mkRun('A-repeat', 'claude-sonnet-5', vec(25));
    const cmp = compare(a, b, noise);
    expect(cmp.discordant).toEqual({ b: 0, c: 15 });
    expect(cmp.diffPp).toBeCloseTo(-37.5, 6);
    expect(decide(cmp, DECISION_THRESHOLDS).verdict).toBe('improvement');
  });

  it('returns no-detectable-regression when the effect is dominated by same-model noise', () => {
    // A passes 20/40. B: on A's 20 passes, fail 6 (b_disc=6); on A's 20 fails, also fail (c=0).
    const aPass = vec(20);
    const bPass = aPass.map((p, i) => (p ? i < 14 : false)); // of A's 20 passes, B fails 6 (idx14-19)
    // A-repeat: flip 15 of A's passes to fail and 15 of A's fails to pass → noise (15,15).
    const arPass = aPass.map((p, i) => (p ? i >= 15 : i < 35)); // heavy disagreement
    const a = mkRun('A', 'claude-sonnet-5', aPass);
    const b = mkRun('B', 'claude-haiku-4-5', bPass);
    const noise = mkRun('A-repeat', 'claude-sonnet-5', arPass);
    const cmp = compare(a, b, noise);
    expect(cmp.discordant).toEqual({ b: 6, c: 0 });
    expect(cmp.noise!.disagree).toBe(30);
    expect(cmp.diffPp).toBeCloseTo(15, 6);
    // 15pp does not exceed the ~25.7pp same-model noise upper bound.
    expect(cmp.noise!.upperPp).toBeGreaterThan(15);
    expect(decide(cmp, DECISION_THRESHOLDS).verdict).toBe('no-detectable-regression');
  });

  it('is inconclusive when a real effect has no noise baseline to qualify it', () => {
    const a = mkRun('A', 'claude-sonnet-5', vec(40));
    const b = mkRun('B', 'claude-haiku-4-5', vec(25));
    const cmp = compare(a, b); // no noise
    expect(decide(cmp, DECISION_THRESHOLDS).verdict).toBe('inconclusive');
  });
});

describe('ci gate', () => {
  it('a cost-per-item increase past the threshold fails ci even when the pass rate improves', () => {
    const a = mkRun('A', 'claude-sonnet-5', vec(25), 0.001);
    const b = mkRun('B', 'claude-haiku-4-5', vec(40), 0.002); // +100% cost, but better quality
    const noise = mkRun('A-repeat', 'claude-sonnet-5', vec(25), 0.001);
    const res = ci(a, b, noise, THRESHOLDS);
    expect(res.verdict).toBe('improvement');
    expect(res.code).toBe(1);
    expect(res.reasons.some((r) => r.includes('cost per item increased'))).toBe(true);
  });

  it('fails ci on a detected regression', () => {
    const a = mkRun('A', 'claude-sonnet-5', vec(40), 0.001);
    const b = mkRun('B', 'claude-haiku-4-5', vec(25), 0.001);
    const noise = mkRun('A-repeat', 'claude-sonnet-5', vec(40), 0.001);
    expect(ci(a, b, noise, THRESHOLDS).code).toBe(1);
  });

  it('passes ci when there is no detectable regression and cost is flat', () => {
    // b_disc=2, c=0 → 5pp, CI includes 0; cost equal.
    const aPass = vec(30);
    const bPass = aPass.map((p, i) => (p ? i >= 2 : false)); // fail 2 of A's passes
    const a = mkRun('A', 'claude-sonnet-5', aPass, 0.001);
    const b = mkRun('B', 'claude-haiku-4-5', bPass, 0.001);
    const noise = mkRun('A-repeat', 'claude-sonnet-5', aPass, 0.001);
    const res = ci(a, b, noise, THRESHOLDS);
    expect(res.verdict).toBe('no-detectable-regression');
    expect(res.code).toBe(0);
  });
});
