import { describe, it, expect } from 'vitest';
import { slotGuard } from '../src/guards';
import { loadProtocol } from '../src/protocol';

const rules = loadProtocol().cacheRules;

describe('slotGuard', () => {
  it('vetoes when a numeric token differs between query and candidate', () => {
    const r = slotGuard('Please cancel order 4471.', 'Please cancel order 4417.', rules);
    expect(r.veto).toBe(true);
    expect(r.reason).toMatch(/numeric/);
  });

  it('vetoes when an identifier token differs but the numeric-only view is unchanged', () => {
    // Both contain the digit "1", but the identifier-shaped tokens "A1" vs "B1" differ.
    const r = slotGuard('Reset password for account A1.', 'Reset password for account B1.', rules);
    expect(r.veto).toBe(true);
    expect(r.reason).toMatch(/identifier/);
  });

  it('vetoes on a polarity flip (negation word introduced)', () => {
    const r = slotGuard('Please cancel my subscription.', 'Please do not cancel my subscription.', rules);
    expect(r.veto).toBe(true);
    expect(r.reason).toMatch(/polarity/);
  });

  it('passes a pure paraphrase (same numbers, identifiers, and polarity)', () => {
    const r = slotGuard('Please cancel order #4471.', 'Can you cancel order #4471 for me?', rules);
    expect(r.veto).toBe(false);
    expect(r.reason).toBeNull();
  });
});
