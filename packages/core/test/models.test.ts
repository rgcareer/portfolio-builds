import { describe, it, expect } from 'vitest';
import {
  MODELS,
  LLM_PRICES,
  assertModelPolicy,
  priceFor,
  computeCostUsd,
  BANNED_MODEL_RE,
} from '@skillcheck/core';

describe('model policy guard', () => {
  it('the real roster and prices load clean (module import did not throw)', () => {
    expect(() => assertModelPolicy()).not.toThrow();
    expect(MODELS.opus).toBe('claude-opus-4-8');
    expect(Object.keys(LLM_PRICES)).not.toContain('claude-opus-5');
  });

  it('throws when a banned id is injected into the roster', () => {
    expect(() => assertModelPolicy({ opus: 'claude-opus-5' }, LLM_PRICES)).toThrow(
      /claude-opus-5 is banned/,
    );
  });

  it('throws when a banned id is injected into the price table', () => {
    expect(() =>
      assertModelPolicy(MODELS, { ...LLM_PRICES, 'claude-opus-5': { in: 5, out: 25 } }),
    ).toThrow(/Offending ids: prices:claude-opus-5/);
  });

  it('matches versioned opus-5 ids but not opus-4-8', () => {
    expect(BANNED_MODEL_RE.test('claude-opus-5-20260101')).toBe(true);
    expect(BANNED_MODEL_RE.test('claude-opus-4-8')).toBe(false);
  });
});

describe('cost accounting', () => {
  it('prices known models and falls back to opus rates for unknown ids', () => {
    expect(priceFor('claude-haiku-4-5')).toEqual({ in: 1, out: 5 });
    expect(priceFor('some-unknown-model')).toEqual(LLM_PRICES['claude-opus-4-8']);
  });

  it('sums all three input fields at the input rate (OH accounting)', () => {
    // haiku: in=1, out=5 ($/Mtok). 1M input-equiv + 1M output = 1*1 + 1*5 = 6.
    const cost = computeCostUsd('claude-haiku-4-5', {
      input: 400_000,
      cacheRead: 400_000,
      cacheCreation: 200_000,
      output: 1_000_000,
    });
    expect(cost).toBeCloseTo(1 * 1 + 1 * 5, 10);
  });

  it('treats missing usage fields as zero', () => {
    expect(computeCostUsd('claude-sonnet-5', {})).toBe(0);
    expect(computeCostUsd('claude-sonnet-5', { output: 1_000_000 })).toBeCloseTo(15, 10);
  });
});
