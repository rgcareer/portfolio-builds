import { describe, it, expect } from 'vitest';
import { MODELS, LLM_PRICES, assertModelPolicy, computeCostUsd, estimateCostCeilingUsd, isBannedModel } from '../src/models';

describe('model policy', () => {
  it('the sanctioned roster pins opus to 4.8 and contains no opus-5', () => {
    expect(MODELS.opus).toBe('claude-opus-4-8');
    for (const id of Object.values(MODELS)) expect(isBannedModel(id)).toBe(false);
    for (const id of Object.keys(LLM_PRICES)) expect(isBannedModel(id)).toBe(false);
    expect(() => assertModelPolicy()).not.toThrow();
  });
  it('throws when a banned id is injected into the roster', () => {
    expect(() => assertModelPolicy({ ...MODELS, opus: 'claude-opus-5' })).toThrow(/banned/);
  });
  it('throws when a banned id is injected into the price table', () => {
    expect(() => assertModelPolicy(MODELS, { ...LLM_PRICES, 'claude-opus-5': { in: 5, out: 25 } })).toThrow(/prices:claude-opus-5/);
  });
  it('flags dated variants too', () => {
    expect(isBannedModel('claude-opus-5-20260101')).toBe(true);
  });
});

describe('cost accounting', () => {
  it('reproduces a real Operation Hired usage line: opus-4-8 in=2912 out=1374 ~$0.0489', () => {
    // logs/regen-template-2026-08-09.log recorded exactly this line; the price table must
    // reproduce it to 4 decimals or the vendored table has drifted.
    const c = computeCostUsd('claude-opus-4-8', { input: 2912, output: 1374 });
    expect(c).toBeCloseTo(0.0489, 4);
  });
  it('sums fresh, cache-read and cache-creation input at the input rate', () => {
    const c = computeCostUsd('claude-sonnet-5', { input: 1_000_000, cacheRead: 1_000_000, cacheCreation: 1_000_000, output: 1_000_000 });
    expect(c).toBeCloseTo(3 * 3 + 15, 9);
  });
  it('unknown models fall back to opus-tier prices (never cheaper than reality)', () => {
    expect(computeCostUsd('some-future-model', { input: 1_000_000 })).toBe(5);
  });
  it('the pre-call ceiling over-estimates input and charges full max_tokens', () => {
    const ceiling = estimateCostCeilingUsd('claude-haiku-4-5', 3000, 500);
    // 1000 input tokens @ $1/M + 500 output @ $5/M
    expect(ceiling).toBeCloseTo(0.001 + 0.0025, 9);
  });
});
