import { describe, it, expect } from 'vitest';
import { loadProtocol } from '../src/protocol';
import { compare } from '../src/compare';
import { buildRunMeta, headlineFromMeta } from '../src/report';
import type { ConditionRun, ItemResult } from '../src/runner';

function mkRun(name: string, model: string, passExact: boolean[], costPerItem = 0.001): ConditionRun {
  const results: ItemResult[] = passExact.map((p, i) => ({
    index: i, id: `WO-${1000 + i}`, model, content: '{}', error: null, costUsd: costPerItem,
    latencyMs: 1, usage: null, mock: true, passParse: true, passExact: p, skipped: null, at: '2026-09-15T00:00:00.000Z',
  }));
  const k = passExact.filter(Boolean).length;
  return { name, model, maxTokens: 400, n: passExact.length, completed: passExact.length, k, kParse: passExact.length, skipped: 0, errors: 0, totalCostUsd: costPerItem * passExact.length, results };
}
const vec = (t: number, n = 40) => Array.from({ length: n }, (_, i) => i < t);

describe('buildRunMeta + headline', () => {
  const proto = loadProtocol();

  it('renders the headline solely through renderHeadline with real values', () => {
    const a = mkRun('A', 'claude-sonnet-5', vec(38), 0.0022);
    const b = mkRun('B', 'claude-haiku-4-5', vec(30), 0.0011);
    const noise = mkRun('A-repeat', 'claude-sonnet-5', vec(38), 0.0022);
    const cmp = compare(a, b, noise, proto.experiment.decision_rule);
    const meta = buildRunMeta(proto, cmp, {
      runDate: '2026-09-15',
      ledgerTotalUsd: 0.26,
      ledgerCalls: 120,
      protocolCommit: 'abc123',
      frozenAt: '2026-09-15T00:00:00.000Z',
      ranAt: '2026-09-15T01:00:00.000Z',
      generatedAt: '2026-09-15T01:00:00.000Z',
    });

    expect(meta.n).toBe(40);
    expect(meta.conditionA.k).toBe(38);
    expect(meta.conditionB.k).toBe(30);
    expect(typeof meta.headline).toBe('string');

    const rendered = headlineFromMeta(proto, meta);
    expect(rendered).toBe(meta.headline);
    expect(rendered).toContain('claude-sonnet-5 passed 38/40');
    expect(rendered).toContain('claude-haiku-4-5 passed 30/40');
    expect(rendered).toContain('run 2026-09-15');
    // No unresolved placeholders survived.
    expect(rendered).not.toMatch(/\{[A-Za-z_]/);
  });

  it('leaves the headline null and unrenderable before any paired data exists', () => {
    const empty = mkRun('A', 'claude-sonnet-5', []);
    const emptyB = mkRun('B', 'claude-haiku-4-5', []);
    const cmp = compare(empty, emptyB, undefined, proto.experiment.decision_rule);
    const meta = buildRunMeta(proto, cmp, { runDate: '2026-09-15', ledgerTotalUsd: 0, ledgerCalls: 0, protocolCommit: null, frozenAt: null, ranAt: null, generatedAt: 'x' });
    expect(meta.headline).toBeNull();
    expect(() => headlineFromMeta(proto, meta)).toThrow();
  });

  it('refuses to render a headline when a value is missing (renderHeadline guard)', () => {
    const a = mkRun('A', 'claude-sonnet-5', vec(38));
    const b = mkRun('B', 'claude-haiku-4-5', vec(30));
    const cmp = compare(a, b, undefined, proto.experiment.decision_rule); // no noise → no noiseK
    const meta = buildRunMeta(proto, cmp, { runDate: '2026-09-15', ledgerTotalUsd: 0, ledgerCalls: 0, protocolCommit: null, frozenAt: null, ranAt: null, generatedAt: 'x' });
    expect(meta.headline).toBeNull();
  });
});
