import { describe, it, expect } from 'vitest';
import { estimateCostCeilingUsd } from '@portfolio-builds/shared';
import { estimateStep } from '../src/estimate';

describe('estimate: estimateStep', () => {
  it('uses shared estimateCostCeilingUsd per call and labels the total as a ceiling', () => {
    const calls = [
      { model: 'claude-haiku-4-5', inputChars: 3000, maxOutputTokens: 500 },
      { model: 'claude-opus-4-8', inputChars: 6000, maxOutputTokens: 1000 },
    ];
    const r = estimateStep(calls);
    const expected = calls.reduce((sum, c) => sum + estimateCostCeilingUsd(c.model, c.inputChars, c.maxOutputTokens), 0);
    expect(r.ceilingUsd).toBeCloseTo(expected, 9);
  });

  it('breaks the ceiling down per model', () => {
    const calls = [
      { model: 'claude-haiku-4-5', inputChars: 3000, maxOutputTokens: 500 },
      { model: 'claude-haiku-4-5', inputChars: 3000, maxOutputTokens: 500 },
      { model: 'claude-opus-4-8', inputChars: 6000, maxOutputTokens: 1000 },
    ];
    const r = estimateStep(calls);
    const haikuOnly = estimateCostCeilingUsd('claude-haiku-4-5', 3000, 500) * 2;
    expect(r.perModel['claude-haiku-4-5']).toBeCloseTo(haikuOnly, 9);
    expect(Object.keys(r.perModel).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-4-8']);
  });

  it('an empty plan estimates to $0', () => {
    const r = estimateStep([]);
    expect(r.ceilingUsd).toBe(0);
    expect(r.perModel).toEqual({});
  });
});
