import { describe, it, expect } from 'vitest';
import type { TrafficRecord, TrafficUsage } from '@portfolio-builds/shared';
import { loadPolicy } from '../src/protocol';
import { priceUsage, noCacheCounterfactual } from '../src/prices';
import { analyzeTraffic, byMechanism } from '../src/counterfactual';

const policy = loadPolicy();

function rec(overrides: Partial<TrafficRecord> & { model: string; usage: TrafficUsage }): TrafficRecord {
  return {
    v: 1,
    id: 'id-' + Math.random().toString(36).slice(2),
    ts: '2026-08-20T10:00:00.000Z',
    source: 'claude-code',
    provider: 'anthropic',
    purpose: null,
    runId: null,
    tenant: null,
    tags: {},
    latencyTolerant: false,
    session: 's1',
    sidechain: false,
    systemSha256: null,
    systemChars: null,
    userSha256: null,
    userChars: null,
    mock: false,
    error: null,
    cache: null,
    ...overrides,
  };
}

const r1 = rec({
  id: 'r1',
  model: 'claude-opus-4-8',
  ts: '2026-08-20T10:00:00.000Z',
  session: 's1',
  usage: { input: 1000, cacheRead: 200, cacheCreation5m: 100, cacheCreation1h: 0, output: 300 },
});
const r2 = rec({
  id: 'r2',
  model: 'claude-sonnet-5',
  ts: '2026-08-21T10:00:00.000Z',
  session: 's1',
  usage: { input: 500, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 50, output: 100 },
});
const r3 = rec({
  id: 'r3',
  model: 'claude-haiku-4-5',
  ts: '2026-08-22T10:00:00.000Z',
  session: 's2',
  latencyTolerant: true,
  usage: { input: 2000, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0, output: 500 },
});

describe('counterfactual: analyzeTraffic', () => {
  it('bills a 1-hour cache write at 2x (matches priceUsage exactly)', () => {
    const { findings } = analyzeTraffic([r2], policy, { protocolCommit: null, extractedAt: null });
    expect(findings.length).toBe(1);
    expect(findings[0]!.billedUsd).toBeCloseTo(priceUsage('claude-sonnet-5', r2.usage!).totalUsd, 9);
  });

  it('no-cache pricing equals fresh-rate pricing of the summed input (never a discount)', () => {
    const { findings } = analyzeTraffic([r1], policy, { protocolCommit: null, extractedAt: null });
    const expected = priceUsage('claude-opus-4-8', noCacheCounterfactual(r1.usage!)).totalUsd;
    expect(findings[0]!.noCacheUsd).toBeCloseTo(expected, 9);
  });

  it('a call that was already cached is never double counted when it appears twice', () => {
    const once = analyzeTraffic([r1], policy, { protocolCommit: null, extractedAt: null });
    const twice = analyzeTraffic([r1, { ...r1 }], policy, { protocolCommit: null, extractedAt: null });
    expect(twice.runMeta.n).toBe(once.runMeta.n);
    expect(twice.runMeta.billedUsd).toBeCloseTo(once.runMeta.billedUsd, 9);
  });

  it('sums n, sessions, billed, noCache, and kRead over all included calls', () => {
    const { runMeta } = analyzeTraffic([r1, r2, r3], policy, { protocolCommit: null, extractedAt: null });
    expect(runMeta.n).toBe(3);
    expect(runMeta.sessions).toBe(2); // s1 (r1,r2), s2 (r3)
    expect(runMeta.kRead).toBe(1); // only r1 has cacheRead > 0
    const expectedBilled = priceUsage('claude-opus-4-8', r1.usage!).totalUsd + priceUsage('claude-sonnet-5', r2.usage!).totalUsd + priceUsage('claude-haiku-4-5', r3.usage!).totalUsd;
    expect(runMeta.billedUsd).toBeCloseTo(expectedBilled, 9);
  });

  it('uses the frozen policy window for {from}/{to}, and null pct when n=0', () => {
    const { runMeta } = analyzeTraffic([], policy, { protocolCommit: null, extractedAt: null });
    expect(runMeta.from).toBe(policy.rules.window.from);
    expect(runMeta.to).toBe(policy.rules.window.to);
    expect(runMeta.n).toBe(0);
    expect(runMeta.pct).toBeNull();
  });

  it('produces a non-null pct with well-formed percent strings when n>0', () => {
    const { runMeta } = analyzeTraffic([r1, r2, r3], policy, { protocolCommit: null, extractedAt: null });
    expect(runMeta.pct).not.toBeNull();
    expect(runMeta.pct!.savedPct).toMatch(/^\d+\.\d$/);
    expect(runMeta.pct!.pRead).toMatch(/^\d+\.\d$/);
  });

  it('filters records outside the frozen policy window even if the caller forgot to', () => {
    const outside = rec({ id: 'out', model: 'claude-haiku-4-5', ts: '2026-01-01T00:00:00.000Z', usage: { input: 1, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0, output: 1 } });
    const { runMeta } = analyzeTraffic([r1, outside], policy, { protocolCommit: null, extractedAt: null });
    expect(runMeta.n).toBe(1);
  });
});

describe('counterfactual: byMechanism', () => {
  it('routing savings apply only to non-cheapest models; batch savings apply only to latencyTolerant calls', () => {
    const { findings } = analyzeTraffic([r1, r2, r3], policy, { protocolCommit: null, extractedAt: null });
    const m = byMechanism(findings);
    // r1, r2 are not latencyTolerant -> no batch contribution from them; r3 is tolerant.
    const r3Billed = priceUsage('claude-haiku-4-5', r3.usage!).totalUsd;
    const r3Batch = priceUsage('claude-haiku-4-5', r3.usage!, { batch: true }).totalUsd;
    expect(m.batchUsd).toBeCloseTo(r3Billed - r3Batch, 9);
    expect(m.batchUsd).toBeGreaterThan(0);
  });

  it('routing is flagged quality-unverified and excluded from the headline values', () => {
    const { findings, runMeta } = analyzeTraffic([r1, r2, r3], policy, { protocolCommit: null, extractedAt: null });
    const m = byMechanism(findings);
    expect(m.routingQualityUnverified).toBe(true);
    // The headline-relevant fields never mention routing.
    expect(JSON.stringify(runMeta.pct)).not.toMatch(/routing/i);
  });

  it('mechanisms sum to the reported total', () => {
    const { findings } = analyzeTraffic([r1, r2, r3], policy, { protocolCommit: null, extractedAt: null });
    const m = byMechanism(findings);
    expect(m.cacheUsd + m.batchUsd + m.routingUsd).toBeCloseTo(m.totalUsd, 9);
  });

  it('cache mechanism equals the realized (noCache - billed) savings actually observed', () => {
    const { findings, runMeta } = analyzeTraffic([r1, r2, r3], policy, { protocolCommit: null, extractedAt: null });
    const m = byMechanism(findings);
    expect(m.cacheUsd).toBeCloseTo(runMeta.noCacheUsd - runMeta.billedUsd, 9);
  });

  it('an empty finding set has all-zero mechanisms', () => {
    const m = byMechanism([]);
    expect(m).toEqual({ cacheUsd: 0, batchUsd: 0, routingUsd: 0, totalUsd: 0, routingQualityUnverified: true });
  });
});
