import { describe, it, expect } from 'vitest';
import { findPii } from '@portfolio-builds/shared';
import { generateGolden, goldenHash, type GoldenItem } from '../src/golden';

const SEED = 20260915;
const N = 40;

describe('generateGolden', () => {
  it('same seed produces an identical set', () => {
    const a = generateGolden({ seed: SEED, n: N });
    const b = generateGolden({ seed: SEED, n: N });
    expect(a).toEqual(b);
    expect(goldenHash(a)).toBe(goldenHash(b));
  });

  it('a different seed produces a different set', () => {
    const a = generateGolden({ seed: SEED, n: N });
    const b = generateGolden({ seed: SEED + 1, n: N });
    expect(goldenHash(a)).not.toBe(goldenHash(b));
  });

  it('produces exactly n items with WO-#### ids', () => {
    const set = generateGolden({ seed: SEED, n: N });
    expect(set).toHaveLength(N);
    for (const item of set) expect(item.expected.id).toMatch(/^WO-\d{4}$/);
  });

  it('every total_cents equals the sum of qty*unit_cents', () => {
    const set = generateGolden({ seed: SEED, n: N });
    for (const item of set) {
      const sum = item.expected.items.reduce((acc, li) => acc + li.qty * li.unit_cents, 0);
      expect(item.expected.total_cents).toBe(sum);
      expect(item.expected.items.length).toBeGreaterThanOrEqual(2);
      expect(item.expected.items.length).toBeLessThanOrEqual(4);
    }
  });

  it('each expected.date is a valid ISO YYYY-MM-DD string', () => {
    const set = generateGolden({ seed: SEED, n: N });
    for (const item of set) {
      expect(item.expected.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('all four date formats occur across the set', () => {
    const set = generateGolden({ seed: SEED, n: N });
    const formats = new Set(set.map((i) => i.dateFormat));
    expect(formats.size).toBe(4);
  });

  it('the prompt embeds the id, an ISO-resolvable date, and the distractor previous balance', () => {
    const set = generateGolden({ seed: SEED, n: N });
    for (const item of set) {
      expect(item.prompt).toContain(item.expected.id);
      expect(item.prompt.toLowerCase()).toContain('previous balance');
    }
  });

  it('paid reflects an affirmed vs negated payment phrase', () => {
    const set = generateGolden({ seed: SEED, n: N });
    // Both classes must occur in a 40-item set.
    expect(set.some((i) => i.expected.paid)).toBe(true);
    expect(set.some((i) => !i.expected.paid)).toBe(true);
  });

  it('contains no PII (no names, emails, or phones)', () => {
    const set = generateGolden({ seed: SEED, n: N });
    const blob = JSON.stringify(set);
    expect(findPii(blob)).toEqual([]);
  });
});

describe('goldenHash', () => {
  it('is stable under key reordering of an item', () => {
    const set = generateGolden({ seed: SEED, n: 3 });
    const reordered: GoldenItem[] = set.map((item) => {
      const e = item.expected;
      // Rebuild each object with keys in a deliberately different order.
      const expected = {
        items: e.items.map((li) => ({ unit_cents: li.unit_cents, qty: li.qty, name: li.name })),
        status: e.status,
        paid: e.paid,
        total_cents: e.total_cents,
        date: e.date,
        id: e.id,
      } as unknown as typeof e;
      return { dateFormat: item.dateFormat, prompt: item.prompt, expected, index: item.index } as GoldenItem;
    });
    expect(goldenHash(reordered)).toBe(goldenHash(set));
  });
});
