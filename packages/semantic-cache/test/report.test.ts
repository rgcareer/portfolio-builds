import { describe, it, expect } from 'vitest';
import { buildRunMeta } from '../src/report';
import { loadProtocol } from '../src/protocol';
import { expandParaphraseSet } from '../src/labelset';
import { FakeEmbedder } from '../src/embedder';
import { sweep } from '../src/sweep';
import { HeadlineError } from '@portfolio-builds/shared';

const protocol = loadProtocol();

async function realCurve() {
  const items = expandParaphraseSet(protocol.paraphraseSet);
  const embedder = new FakeEmbedder();
  const vectors = await embedder.embed(items.map((i) => i.text));
  const vecs = new Map(items.map((item, i) => [item.id, vectors[i]!]));
  return sweep(items, vecs, protocol.cacheRules.sweep.tau_grid, true, protocol.cacheRules);
}

describe('buildRunMeta', () => {
  it('renders a headline with real, measured numbers at the shipped tau', async () => {
    const curve = await realCurve();
    const meta = buildRunMeta(curve, protocol, '2026-09-15T00:00:00.000Z');
    expect(meta.shippedTau).toBe(0.9);
    expect(meta.nBase).toBe(40);
    expect(meta.kPara).toBe(3);
    expect(meta.kNeg).toBe(3);
    expect(meta.nItems).toBe(40 * 7);
    expect(meta.headline).toContain(`${meta.nItems} hand-written queries`);
    expect(meta.headline).toContain('embeddings cost $0');
    expect(meta.costUsd).toBe(0);
    expect(meta.protocolHash).toBe(protocol.hash);
  });

  it('throws when the curve has no point at the protocol shipped_tau', () => {
    const emptyCurve = [{ tau: 0.5, hit: { p: 0, lo: 0, hi: 0, k: 0, n: 1, z: 1.96 }, falseHit: { p: 0, lo: 0, hi: 0, k: 0, n: 1, z: 1.96 } }];
    expect(() => buildRunMeta(emptyCurve, protocol, '2026-09-15T00:00:00.000Z')).toThrow();
  });

  it('never produces a headline with an unresolved placeholder (renderHeadline would refuse it)', async () => {
    const curve = await realCurve();
    // Sanity: renderHeadline itself would throw HeadlineError on a bad template, and
    // buildRunMeta must not swallow that.
    const badProtocol = { ...protocol, cacheRules: { ...protocol.cacheRules, headline_template: '{nonexistentField}' } };
    expect(() => buildRunMeta(curve, badProtocol, '2026-09-15T00:00:00.000Z')).toThrow(HeadlineError);
  });
});
