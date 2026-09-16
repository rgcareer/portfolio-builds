import { describe, it, expect } from 'vitest';
import { LLM_PRICES } from '@portfolio-builds/shared';
import { priceUsage, noCacheCounterfactual, minCacheablePrefix, driftVsShared } from '../src/prices';

const zero = { input: 0, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0, output: 0 };

describe('prices: verified table values', () => {
  it('prices fresh input and output at the model list rate', () => {
    const r = priceUsage('claude-opus-4-8', { ...zero, input: 1_000_000, output: 1_000_000 });
    expect(r.inputUsd).toBeCloseTo(5, 9);
    expect(r.outputUsd).toBeCloseTo(25, 9);
    expect(r.totalUsd).toBeCloseTo(30, 9);
  });

  it('reproduces the OH line: opus-4-8 in=2912/out=1374 -> $0.0489 at 1x cache accounting', () => {
    const r = priceUsage('claude-opus-4-8', { ...zero, input: 2912, output: 1374 });
    expect(r.totalUsd).toBeCloseTo(0.0489, 4);
  });

  it('unpriced model throws', () => {
    expect(() => priceUsage('claude-nonexistent-9', zero)).toThrow(/unpriced|no verified price/i);
  });
});

describe('prices: multipliers 0.1 / 0.025 / 1.25 / 2', () => {
  it('cacheRead multiplier is 0.1x for non-fable-5.1 models', () => {
    const r = priceUsage('claude-opus-4-8', { ...zero, cacheRead: 1_000_000 });
    expect(r.inputUsd).toBeCloseTo(5 * 0.1, 9);
  });

  it('cacheRead multiplier is 0.025x for claude-fable-5-1', () => {
    const r = priceUsage('claude-fable-5-1', { ...zero, cacheRead: 1_000_000 });
    expect(r.inputUsd).toBeCloseTo(10 * 0.025, 9);
  });

  it('cache write 5m multiplier is 1.25x', () => {
    const r = priceUsage('claude-sonnet-5', { ...zero, cacheCreation5m: 1_000_000 });
    expect(r.inputUsd).toBeCloseTo(2 * 1.25, 9);
  });

  it('cache write 1h multiplier is 2x', () => {
    const r = priceUsage('claude-sonnet-5', { ...zero, cacheCreation1h: 1_000_000 });
    expect(r.inputUsd).toBeCloseTo(2 * 2, 9);
  });
});

describe('prices: batch halves in+out and stacks with cache discounts', () => {
  it('batch alone halves fresh input and output', () => {
    const noBatch = priceUsage('claude-haiku-4-5', { ...zero, input: 1_000_000, output: 1_000_000 });
    const batch = priceUsage('claude-haiku-4-5', { ...zero, input: 1_000_000, output: 1_000_000 }, { batch: true });
    expect(batch.totalUsd).toBeCloseTo(noBatch.totalUsd * 0.5, 9);
  });

  it('batch stacks multiplicatively with a cache-read discount', () => {
    const cacheOnly = priceUsage('claude-haiku-4-5', { ...zero, cacheRead: 1_000_000 });
    const cacheAndBatch = priceUsage('claude-haiku-4-5', { ...zero, cacheRead: 1_000_000 }, { batch: true });
    expect(cacheAndBatch.totalUsd).toBeCloseTo(cacheOnly.totalUsd * 0.5, 9);
  });
});

describe('prices: noCacheCounterfactual', () => {
  it('moves every input class to fresh input and leaves output untouched', () => {
    const usage = { input: 100, cacheRead: 200, cacheCreation5m: 30, cacheCreation1h: 40, output: 500 };
    const nc = noCacheCounterfactual(usage);
    expect(nc).toEqual({ input: 370, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0, output: 500 });
  });

  it('no-cache pricing of the counterfactual equals fresh-rate pricing of the summed input', () => {
    const usage = { input: 100, cacheRead: 200, cacheCreation5m: 30, cacheCreation1h: 40, output: 500 };
    const nc = noCacheCounterfactual(usage);
    const priced = priceUsage('claude-sonnet-5', nc);
    const expected = ((100 + 200 + 30 + 40) * 2 + 500 * 10) / 1e6;
    expect(priced.totalUsd).toBeCloseTo(expected, 9);
  });
});

describe('prices: minCacheablePrefix', () => {
  it('reads the verified per-model prefix minimum', () => {
    expect(minCacheablePrefix('claude-haiku-4-5')).toBe(4096);
    expect(minCacheablePrefix('claude-fable-5-1')).toBe(512);
  });
});

describe('prices: driftVsShared', () => {
  it('reports none now (shared was corrected to 2/10)', () => {
    expect(driftVsShared()).toEqual([]);
  });

  it('shared LLM_PRICES sonnet-5 in fact matches the verified table (regression guard for the drift check itself)', () => {
    expect(LLM_PRICES['claude-sonnet-5']).toEqual({ in: 2, out: 10 });
  });
});
