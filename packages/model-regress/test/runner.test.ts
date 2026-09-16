import { describe, it, expect } from 'vitest';
import { Ledger, parseRunRecord, computeCostUsd, estimateCostCeilingUsd, type LlmSpec } from '@portfolio-builds/shared';
import { generateGolden, type GoldenItem } from '../src/golden';
import { runCondition, toRunRecord } from '../src/runner';

const SYSTEM =
  "Return exactly one JSON object with keys id, date, total_cents, paid, status, items and no prose.";

/** A mock that answers each prompt with that item's exact expected JSON. */
function perfectMock(set: GoldenItem[]): (spec: LlmSpec) => string {
  const byPrompt = new Map(set.map((i) => [i.prompt, JSON.stringify(i.expected)]));
  return (spec) => byPrompt.get(spec.user) ?? '{}';
}

describe('runCondition (mock)', () => {
  it('yields n results at $0 with mock=true, all exact-json passing', async () => {
    const set = generateGolden({ seed: 20260915, n: 12 });
    const run = await runCondition(
      set,
      { name: 'A', model: 'claude-sonnet-5', maxTokens: 400 },
      { mock: perfectMock(set), system: SYSTEM },
    );
    expect(run.results).toHaveLength(12);
    expect(run.completed).toBe(12);
    expect(run.k).toBe(12);
    expect(run.kParse).toBe(12);
    expect(run.totalCostUsd).toBe(0);
    expect(run.results.every((r) => r.mock)).toBe(true);
    expect(run.results.every((r) => typeof r.latencyMs === 'number')).toBe(true);
  });

  it('a gateway error becomes a failed item, never a throw', async () => {
    const set = generateGolden({ seed: 20260915, n: 5 });
    const run = await runCondition(
      set,
      { name: 'A', model: 'claude-sonnet-5', maxTokens: 400 },
      {
        mock: () => {
          throw new Error('boom');
        },
        system: SYSTEM,
      },
    );
    expect(run.results).toHaveLength(5);
    expect(run.errors).toBe(5);
    expect(run.k).toBe(0);
    expect(run.results.every((r) => r.error !== null && r.passExact === false)).toBe(true);
  });

  it("every item's RunRecord passes parseRunRecord", async () => {
    const set = generateGolden({ seed: 20260915, n: 6 });
    const run = await runCondition(
      set,
      { name: 'A', model: 'claude-sonnet-5', maxTokens: 400 },
      { mock: perfectMock(set), system: SYSTEM },
    );
    for (const r of run.results) {
      const item = set[r.index]!;
      const rec = toRunRecord(item, r);
      expect(() => parseRunRecord(rec)).not.toThrow();
      expect(rec.source.kind).toBe('eval-item');
      expect(rec.redaction).toBe('verbatim');
    }
  });

  it('records latencyMs as a finite number on every item', async () => {
    const set = generateGolden({ seed: 20260915, n: 4 });
    const run = await runCondition(
      set,
      { name: 'A', model: 'claude-sonnet-5', maxTokens: 400 },
      { mock: perfectMock(set), system: SYSTEM },
    );
    expect(run.results.every((r) => Number.isFinite(r.latencyMs) && r.latencyMs >= 0)).toBe(true);
  });

  it('a mid-run spend-cap refusal marks the item and every remaining item skipped:spend-cap', async () => {
    // Real path with an injected fetch (offline, deterministic, not a real LLM call).
    const set = generateGolden({ seed: 20260915, n: 8 });
    const model = 'claude-sonnet-5';
    const maxTokens = 50;
    // Fake response: 100 output tokens => $0.001 per call for sonnet.
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 0, output_tokens: 100 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const callCost = computeCostUsd(model, { input: 0, output: 100 }); // 0.001
    const ceilingPerItem = estimateCostCeilingUsd(model, SYSTEM.length + set[0]!.prompt.length, maxTokens);
    // Allow ~2 successful calls, then the pre-call ceiling check trips.
    const cap = callCost * 2 + ceilingPerItem * 1.5;

    const ledger = new Ledger();
    const run = await runCondition(
      set,
      { name: 'A', model, maxTokens },
      { system: SYSTEM, ledger, spendCapUsd: cap, env: { ANTHROPIC_API_KEY: 'test-key' }, fetchImpl: fakeFetch },
    );
    ledger.close();

    expect(run.results).toHaveLength(8);
    const firstSkip = run.results.findIndex((r) => r.skipped === 'spend-cap');
    expect(firstSkip).toBeGreaterThan(0); // at least one item completed first
    // Every item from the first skip onward is skipped:spend-cap (contiguous suffix).
    for (let i = firstSkip; i < run.results.length; i++) {
      expect(run.results[i]!.skipped).toBe('spend-cap');
    }
    // Nothing before the first skip is skipped.
    for (let i = 0; i < firstSkip; i++) {
      expect(run.results[i]!.skipped).toBeNull();
    }
    expect(run.skipped).toBe(run.results.length - firstSkip);
  });
});
