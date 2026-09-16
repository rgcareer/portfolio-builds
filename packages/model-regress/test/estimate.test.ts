import { describe, it, expect } from 'vitest';
import { computeCostUsd, estimateCostCeilingUsd } from '@portfolio-builds/shared';
import { estimateRun } from '../src/estimate';
import type { GoldenItem } from '../src/golden';

function itemWithPrompt(prompt: string): GoldenItem {
  return {
    index: 0,
    prompt,
    dateFormat: 'iso',
    expected: { id: 'WO-0001', date: '2026-01-01', total_cents: 0, paid: false, status: 'open', items: [] },
  };
}

describe('estimateRun', () => {
  it('a one-item estimate equals the hand computation', () => {
    const system = 'S'.repeat(120);
    const prompt = 'P'.repeat(300);
    const set = [itemWithPrompt(prompt)];
    const model = 'claude-sonnet-5';
    const maxTokens = 400;

    const est = estimateRun(set, model, { system, maxTokens });
    const chars = system.length + prompt.length; // 420

    // expected: input at chars/4, output at maxTokens/2
    const expectedInputTokens = Math.ceil(chars / 4); // 105
    const expectedOutputTokens = Math.ceil(maxTokens / 2); // 200
    const expectedUsd = computeCostUsd(model, { input: expectedInputTokens, output: expectedOutputTokens });

    // ceiling: input at chars/3, output at maxTokens (matches the gateway's own cap math)
    const ceilingUsd = estimateCostCeilingUsd(model, chars, maxTokens);

    expect(est.calls).toBe(1);
    expect(est.expectedUsd).toBeCloseTo(expectedUsd, 12);
    expect(est.ceilingUsd).toBeCloseTo(ceilingUsd, 12);
    // sanity on the literal arithmetic
    expect(est.expectedUsd).toBeCloseTo(0.00221, 12);
    expect(est.ceilingUsd).toBeCloseTo(0.00428, 12);
  });

  it('scales linearly with the number of items', () => {
    const system = 'x'.repeat(50);
    const set = [itemWithPrompt('a'.repeat(100)), itemWithPrompt('a'.repeat(100))];
    const one = estimateRun([set[0]!], 'claude-haiku-4-5', { system, maxTokens: 200 });
    const two = estimateRun(set, 'claude-haiku-4-5', { system, maxTokens: 200 });
    expect(two.calls).toBe(2);
    expect(two.expectedUsd).toBeCloseTo(one.expectedUsd * 2, 12);
    expect(two.ceilingUsd).toBeCloseTo(one.ceilingUsd * 2, 12);
  });
});
