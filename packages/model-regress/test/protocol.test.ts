import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256Canonical, LLM_PRICES, stableStringify } from '@portfolio-builds/shared';
import { loadExperiment, loadProtocol, verifyGolden, protocolFrozenAudit } from '../src/protocol';
import { generateGolden, goldenHash, GoldenLoadError } from '../src/golden';
import { estimateRun } from '../src/estimate';

describe('loadExperiment / loadProtocol', () => {
  it('loads the frozen experiment with the three conditions in order', () => {
    const exp = loadExperiment();
    expect(exp.conditions.map((c) => c.name)).toEqual(['A', 'B', 'A-repeat']);
    expect(exp.conditions.map((c) => c.model)).toEqual(['claude-sonnet-5', 'claude-haiku-4-5', 'claude-sonnet-5']);
    expect(exp.golden).toEqual({ path: 'golden/golden-v1.json', seed: 20260915, n: 40, generator_version: 1 });
    expect(exp.task.maxTokens).toBe(400);
  });

  it('the protocol hash covers experiment.json AND the regenerated golden hash', () => {
    const proto = loadProtocol();
    const exp = loadExperiment();
    const expectedGoldenHash = goldenHash(generateGolden({ seed: exp.golden.seed, n: exp.golden.n }));
    expect(proto.goldenHash).toBe(expectedGoldenHash);
    expect(proto.hash).toBe(sha256Canonical({ experiment: exp, goldenHash: expectedGoldenHash }));
    // A change to either input changes the protocol hash.
    const tampered = sha256Canonical({ experiment: { ...exp, version: 999 }, goldenHash: expectedGoldenHash });
    expect(tampered).not.toBe(proto.hash);
  });

  it('experiment prices match the shared verified table', () => {
    const exp = loadExperiment();
    for (const model of Object.keys(exp.prices)) {
      expect(exp.prices[model]).toEqual(LLM_PRICES[model]);
    }
  });

  it('the pre-registered spend estimate matches estimateRun over the golden set', () => {
    const exp = loadExperiment();
    const set = generateGolden({ seed: exp.golden.seed, n: exp.golden.n });
    let expected = 0;
    let ceiling = 0;
    for (const c of exp.conditions) {
      const e = estimateRun(set, c.model, { system: exp.task.system, maxTokens: exp.task.maxTokens });
      expected += e.expectedUsd;
      ceiling += e.ceilingUsd;
    }
    expect(exp.spend.expected_usd).toBeCloseTo(expected, 6);
    expect(exp.spend.ceiling_usd).toBeCloseTo(ceiling, 6);
    expect(exp.spend.ceiling_usd).toBeLessThan(exp.spend.cap_usd);
  });
});

describe('verifyGolden', () => {
  it('accepts a golden file whose hash matches the protocol and rejects an edited one', () => {
    const proto = loadProtocol();
    const dir = mkdtempSync(resolve(tmpdir(), 'mr-golden-'));
    try {
      const good = resolve(dir, 'golden-v1.json');
      const set = generateGolden({ seed: proto.experiment.golden.seed, n: proto.experiment.golden.n });
      writeFileSync(good, stableStringify(set));
      expect(() => verifyGolden(proto, good)).not.toThrow();

      // Edit one field — hash no longer matches, loading refuses.
      const edited = structuredClone(set);
      edited[0]!.expected.total_cents += 1;
      const bad = resolve(dir, 'golden-edited.json');
      writeFileSync(bad, stableStringify(edited));
      expect(() => verifyGolden(proto, bad)).toThrow(GoldenLoadError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('protocolFrozenAudit', () => {
  const proto = loadProtocol();
  it('passes when run-state records the frozen protocol hash and the commit precedes the run', () => {
    const audit = protocolFrozenAudit(proto, {
      protocolHash: proto.hash,
      goldenHash: proto.goldenHash,
      protocolCommit: 'abc123',
      frozenAt: '2026-09-15T00:00:00.000Z',
      ranAt: '2026-09-15T01:00:00.000Z',
    });
    expect(audit.ok).toBe(true);
  });

  it('fails when the protocol hash drifted from what was frozen', () => {
    const audit = protocolFrozenAudit(proto, {
      protocolHash: 'deadbeef',
      goldenHash: proto.goldenHash,
      protocolCommit: 'abc123',
      frozenAt: '2026-09-15T00:00:00.000Z',
      ranAt: '2026-09-15T01:00:00.000Z',
    });
    expect(audit.ok).toBe(false);
    expect(audit.reasons.join(' ')).toMatch(/protocol hash/i);
  });

  it('fails when the run happened before the protocol was frozen', () => {
    const audit = protocolFrozenAudit(proto, {
      protocolHash: proto.hash,
      goldenHash: proto.goldenHash,
      protocolCommit: 'abc123',
      frozenAt: '2026-09-15T02:00:00.000Z',
      ranAt: '2026-09-15T01:00:00.000Z',
    });
    expect(audit.ok).toBe(false);
  });

  it('does a literal commit-time check when the commit timestamp is supplied', () => {
    const state = {
      protocolHash: proto.hash,
      goldenHash: proto.goldenHash,
      protocolCommit: 'abc123',
      frozenAt: '2026-09-15T00:00:00.000Z',
      ranAt: '2026-09-15T01:00:00.000Z',
    };
    // Commit precedes the run → passes.
    expect(protocolFrozenAudit(proto, state, { commitAt: '2026-09-15T00:30:00.000Z' }).ok).toBe(true);
    // Commit made after the run started → fails, citing the commit itself.
    const late = protocolFrozenAudit(proto, state, { commitAt: '2026-09-15T02:00:00.000Z' });
    expect(late.ok).toBe(false);
    expect(late.reasons.join(' ')).toMatch(/commit/i);
  });
});
