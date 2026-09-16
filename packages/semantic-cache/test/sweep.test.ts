import { describe, it, expect } from 'vitest';
import { sweep, tauGrid } from '../src/sweep';
import { expandParaphraseSet, type LabeledItem } from '../src/labelset';
import { FakeEmbedder } from '../src/embedder';
import { loadProtocol } from '../src/protocol';

const protocol = loadProtocol();

async function embedAll(items: LabeledItem[]) {
  const embedder = new FakeEmbedder();
  const vectors = await embedder.embed(items.map((i) => i.text));
  const vecs = new Map<string, Float32Array>();
  items.forEach((item, i) => vecs.set(item.id, vectors[i]!));
  return vecs;
}

describe('tauGrid', () => {
  it('produces 0.70..0.99 step 0.01 inclusive (30 points)', () => {
    const grid = tauGrid({ start: 0.7, stop: 0.99, step: 0.01 });
    expect(grid).toHaveLength(30);
    expect(grid[0]).toBeCloseTo(0.7, 6);
    expect(grid[grid.length - 1]).toBeCloseTo(0.99, 6);
  });
});

describe('sweep (synthetic vectors)', () => {
  it('computes exact hit/false-hit counts and Wilson intervals at a given tau', () => {
    // Two intents; the first's paraphrase is identical to base (hits), the second's
    // negative is identical to base (a false hit at any tau <= 1).
    const items: LabeledItem[] = [
      { id: 'i1:base', intentId: 'i1', domain: 'support', role: 'base', text: 'Please cancel order 1.', slotValue: '1' },
      { id: 'i1:paraphrase:0', intentId: 'i1', domain: 'support', role: 'paraphrase', text: 'Please cancel order 1.', slotValue: '1' },
      { id: 'i1:negative:polarity:0', intentId: 'i1', domain: 'support', role: 'negative', kind: 'polarity', text: 'Please do not cancel order 1.', slotValue: '1' },
    ];
    const vecs = new Map<string, Float32Array>([
      ['i1:base', new Float32Array([1, 0])],
      ['i1:paraphrase:0', new Float32Array([1, 0])], // identical -> cosine 1
      ['i1:negative:polarity:0', new Float32Array([1, 0])], // identical vector, but guard should catch it
    ]);
    const points = sweep(items, vecs, { start: 0.9, stop: 0.9, step: 0.01 }, true, protocol.cacheRules);
    expect(points).toHaveLength(1);
    const p = points[0]!;
    expect(p.hit.k).toBe(1);
    expect(p.hit.n).toBe(1);
    expect(p.falseHit.n).toBe(1);
    expect(p.falseHit.k).toBe(0); // guard vetoes the polarity negative even though cosine is 1
    expect(p.hit.lo).toBeLessThanOrEqual(p.hit.p);
    expect(p.hit.hi).toBeGreaterThanOrEqual(p.hit.p);
  });

  it('hit rate is non-increasing as tau increases', async () => {
    const items = expandParaphraseSet(protocol.paraphraseSet);
    const vecs = await embedAll(items);
    const points = sweep(items, vecs, protocol.cacheRules.sweep.tau_grid, true, protocol.cacheRules);
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.hit.p).toBeLessThanOrEqual(points[i - 1]!.hit.p + 1e-9);
    }
  });

  it('false-hit rate with guards enabled is never greater than with guards disabled, at every tau', async () => {
    const items = expandParaphraseSet(protocol.paraphraseSet);
    const vecs = await embedAll(items);
    const grid = { start: 0.5, stop: 0.99, step: 0.07 };
    const guardsOn = sweep(items, vecs, grid, true, protocol.cacheRules);
    const guardsOff = sweep(items, vecs, grid, false, protocol.cacheRules);
    for (let i = 0; i < guardsOn.length; i++) {
      expect(guardsOn[i]!.falseHit.k).toBeLessThanOrEqual(guardsOff[i]!.falseHit.k);
    }
  });
});
